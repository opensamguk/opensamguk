import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import {
  applyCapsRecordedInput,
  applyTreatyInput,
  buildYearbook,
  capsResourceHashInput,
  monthlyDate,
  nextGameAction,
  parseCapsOrigin,
  runCapsReplayAction,
  selectSupportedCapabilities,
  startCapsReplay,
  selectWorldCapabilities,
  type CapsOrigin,
  type RecordedInput,
  type TreatyInput,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { monthlyFixture } from '../test/monthlyFixture';
import { exportReplay, replayArchive as legacyReplay, replayToEnd } from './replay';
import { exportCapsArchive, readCapsArchive, replayCapsArchive, replayCapsToEnd, type CapsArchive } from './replayCaps';

const clone = <T>(value: T): T => structuredClone(value);
type Mode = 'off' | 'default' | 'human' | 'npc';
const clauses = [{ kind: 'peace' as const }, { kind: 'nonAggression' as const, months: 1 }];

// 기대 해시는 기존 공개 순수 함수를 걷고 만든다. DB·adapter·수출 함수를 쓰지 않는다.
async function fixture(mode: Mode = 'off', fromSequence = 3): Promise<CapsArchive> {
  const initial = await monthlyFixture();
  initial.nations.forEach((nation) => {
    nation.gold = 100000;
    nation.isNpc = false;
  });
  initial.generals[0]!.officerLevel = 12;
  initial.generals[1]!.officerLevel = 12;
  if (mode === 'human' || mode === 'default') initial.generals[0]!.userId = 'caps-replay-fixture';
  initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
  const origin: CapsOrigin = {
    version: 6,
    initial,
    initialStateHash: hashState(initial),
    resourceHash: '',
    capabilities: { version: 1, treaty: { version: 1 } },
  };
  origin.resourceHash = hashState(capsResourceHashInput(origin));
  const archive: CapsArchive = {
    version: 6,
    origin,
    config: {
      endYear: initial.startYear,
      outcomeFromSequence: 0,
      ...(mode === 'off'
        ? {}
        : { policy: { version: 1, fromSequence: mode === 'default' ? 0 : fromSequence, turnTermMinutes: 30 } }),
    },
    inputs: [],
    months: [],
    end: null,
    afterEnd: [],
  };
  const selected = selectSupportedCapabilities(origin, archive.config);
  let replay = startCapsReplay(origin, selected);
  const untouched = new Set(initial.generals.map((general) => general.id));
  let at = 0;
  let lastActionTick = 0;
  const addTreaty = (request: TreatyInput & { generalId: number }, tick: number) => {
    const applied = applyTreatyInput(replay.state, request, { tick, sequence: ++at });
    if (!applied.ok) throw new Error(`조약 fixture 실패: ${applied.result.code}`);
    const record: RecordedInput = { ...request, sequence: at, status: 'APPLIED', result: applied.result };
    archive.inputs.push(record);
    replay = applyCapsRecordedInput(replay, record, { selection: selected });
  };
  addTreaty({ kind: 'treaty.propose', generalId: 1, payload: { toNationId: 2, clauses } }, 0);
  addTreaty({ kind: 'treaty.respond', generalId: 2, payload: { treatyId: '1', accept: true } }, 1);
  while (archive.months.length < 12) {
    if (selected.policy && selected.policy.fromSequence > 0 && at + 1 === selected.policy.fromSequence) {
      const emptySlots = [...untouched].sort((a, b) => a - b);
      const clockTick = Math.max(600, lastActionTick + 50);
      const marker: RecordedInput = {
        sequence: ++at,
        generalId: null,
        kind: 'system.policy.enable',
        status: 'APPLIED',
        payload: { version: 5, emptySlots },
        result: {
          fromSequence: at,
          emptySlots,
          clockTick,
          turnTermMinutes: 30,
          baselineActiveTick: mode === 'human' ? clockTick : null,
        },
      };
      archive.inputs.push(marker);
      replay = applyCapsRecordedInput(replay, marker, { selection: selected });
      continue;
    }
    const action = nextGameAction(replay);
    replay = runCapsReplayAction(replay, initial.seed, initial.unitSet, selected);
    at++;
    lastActionTick = action.tick;
    if (action.kind === 'turn') untouched.delete(action.generalId);
    else {
      const date = monthlyDate(initial.startYear, action.tick);
      archive.months.push({
        tick: action.tick,
        ...date,
        sequence: at,
        stateHash: hashState(replay),
        data: buildYearbook(replay.state, date.year),
      });
      if (archive.months.length === 12)
        archive.end = {
          sequence: at,
          tick: action.tick,
          reason: 'END_YEAR',
          winnerNationId: null,
          ...date,
          finalStateHash: hashState(replay),
        };
    }
  }
  archive.afterEnd.push({
    sequence: at + 1,
    generalId: 1,
    kind: 'treaty.propose',
    status: 'REJECTED',
    payload: { toNationId: 2, clauses },
    result: { tick: archive.end!.tick + 1, code: 'WORLD_CLOSED', message: '종료된 월드입니다.' },
  });
  return archive;
}

let off: CapsArchive;
let defaults: CapsArchive;
let human: CapsArchive;
let npc: CapsArchive;
let delayed: CapsArchive;
beforeAll(async () => {
  [off, defaults, human, npc, delayed] = await Promise.all([
    fixture(),
    fixture('default'),
    fixture('human'),
    fixture('npc'),
    fixture('human', 7),
  ]);
});

// DB 수출의 단위 fixture다. 실제 PostgreSQL이나 snapshot 격리의 증거는 아니다.
function exportFixture(source: CapsArchive, ended = true) {
  const snapshot = clone(source);
  const initial = snapshot.origin.initial;
  const json = (value: unknown): Prisma.JsonValue => JSON.parse(JSON.stringify(value));
  const world: Prisma.WorldGetPayload<Record<string, never>> = {
    id: 'caps-export',
    name: '수출 단위 시험',
    presetKey: null,
    preset: null,
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    seed: initial.seed,
    startYear: initial.startYear,
    endYear: snapshot.config.endYear,
    clockMode: 'ACCELERATED',
    outcomeFromSequence: snapshot.config.outcomeFromSequence,
    turnTermMinutes: 30,
    status: ended ? 'ENDED' : 'RUNNING',
    clockTick: snapshot.end?.tick ?? 0,
    clockAnchorAt: null,
    clockRevision: 0,
    startedAt: null,
    endedAt: null,
    initialStateHash: snapshot.origin.initialStateHash,
    statRules: json(initial.statRules),
    unitSet: json(initial.unitSet),
    createdAt: new Date(0),
    monthlyTick: snapshot.months.at(-1)?.tick ?? 0,
    actionSequence:
      snapshot.afterEnd.at(-1)?.sequence ?? snapshot.end?.sequence ?? snapshot.months.at(-1)?.sequence ?? 0,
    policyFromSequence: snapshot.config.policy?.fromSequence ?? null,
    treatyFormat: 1,
    personnelFormat: null,
    replayOrigin: json(snapshot.origin),
    commandMeta: null,
  };
  const currentRows: Prisma.TreatyGetPayload<Record<string, never>>[] = [];
  const events: (Omit<RecordedInput, 'status'> & { status: RecordedInput['status'] | 'PENDING' })[] = [
    ...snapshot.inputs,
    ...snapshot.afterEnd,
  ];
  const tx = {
    world: { findUniqueOrThrow: vi.fn(async () => world) },
    treaty: {
      findMany: vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
        currentRows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => select[key]))),
      ),
    },
    yearbookSnapshot: { findMany: vi.fn(async () => snapshot.months) },
    worldResult: {
      findUnique: vi.fn(async () =>
        ended && snapshot.end
          ? {
              endedSequence: snapshot.end.sequence,
              endedTick: snapshot.end.tick,
              reason: snapshot.end.reason,
              winnerNationId: snapshot.end.winnerNationId,
              endedYear: snapshot.end.year,
              endedMonth: snapshot.end.month,
              finalStateHash: snapshot.end.finalStateHash,
            }
          : null,
      ),
    },
    inputEvent: {
      findMany: vi.fn(async ({ where }: { where: { sequence: { lte?: number; not?: null } } }) =>
        events.filter((event) => where.sequence.lte === undefined || event.sequence <= where.sequence.lte),
      ),
    },
    $transaction: vi.fn(() => {
      throw new Error('중첩 트랜잭션 금지');
    }),
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
  // Prisma client 전체 대신 읽기 호출만 가진 단위 fixture를 경계에서 한 번 변환한다.
  const db = { $transaction: transaction } as unknown as PrismaClient;
  return { snapshot, world, currentRows, events, tx, db, transaction };
}

describe('T4-03 형식 6 실제 수출 함수와 공개 분기 단위 계약', () => {
  it.each(['off', 'default', 'human', 'npc'] as const)(
    'E1 %s는 실제 gate와 같은 RR callback으로 수출하고 bytes가 안정적이다',
    async (mode) => {
      const expected = { off, default: defaults, human, npc }[mode];
      const model = exportFixture(expected);
      const first = await exportReplay(model.db, model.world.id);
      const second = await exportReplay(model.db, model.world.id);
      expect(first).toEqual(expected);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(model.transaction).toHaveBeenCalledTimes(2);
      for (const call of model.transaction.mock.calls)
        expect(call).toEqual([expect.any(Function), { isolationLevel: 'RepeatableRead' }]);
      expect(model.tx.world.findUniqueOrThrow).toHaveBeenCalledTimes(2);
      expect(model.tx.treaty.findMany).toHaveBeenCalledTimes(2);
      expect(model.tx.$transaction).not.toHaveBeenCalled();
      expect(model.tx.inputEvent.findMany).toHaveBeenCalledWith({
        where: { worldId: model.world.id, sequence: { not: null } },
        orderBy: { sequence: 'asc' },
      });
      expect(legacyReplay(first)).toEqual(replayCapsArchive(expected));
      expect(replayToEnd(first)).toEqual(expected.end);
    },
  );

  it('E2 현재 닫힌 조약 행은 실제 gate가 검사하고 얼린 initial·resourceHash에 섞지 않는다', async () => {
    const model = exportFixture(off);
    model.currentRows.push({
      worldId: model.world.id,
      id: 100,
      fromNationId: 1,
      toNationId: 2,
      clauses,
      status: 'ENDED',
      proposedTick: 0,
      respondByTick: 60000,
      startTick: 1,
      endTick: 10001,
      closedSequence: 20,
      costFrom: 10,
      costTo: 10,
    });
    expect(await exportReplay(model.db, model.world.id)).toEqual(off);
    model.currentRows[0]!.closedSequence = null;
    await expect(exportReplay(model.db, model.world.id)).rejects.toThrow('마감 기록');
    expect(model.tx.yearbookSnapshot.findMany).toHaveBeenCalledTimes(1);
  });

  it('E3 진행 중 coverage까지만 읽고 F가 coverage 밖이면 표지를 빼도 앞 달을 재현한다', async () => {
    const model = exportFixture(delayed, false);
    model.snapshot.months = model.snapshot.months.slice(0, 1);
    const coverage = model.snapshot.months[0]!.sequence;
    expect(coverage).toBeLessThan(delayed.config.policy!.fromSequence);
    const archive = await exportReplay(model.db, model.world.id);
    expect(archive.end).toBeNull();
    expect(archive.afterEnd).toEqual([]);
    expect(archive.inputs.map((input) => input.sequence)).toEqual([1, 2]);
    expect(model.tx.inputEvent.findMany).toHaveBeenCalledWith({
      where: { worldId: model.world.id, sequence: { lte: coverage } },
      orderBy: { sequence: 'asc' },
    });
    expect(legacyReplay(archive, 1)).toEqual(replayCapsArchive(delayed, 1));
  });

  it('E4 첫 정산 전 coverage0은 입력을 내보내지 않고 과거 상태를 현재 상태로 바꾸지 않는다', async () => {
    const model = exportFixture(off, false);
    model.snapshot.months = [];
    const archive = await exportReplay(model.db, model.world.id);
    expect(archive).toEqual({ ...off, months: [], inputs: [], end: null, afterEnd: [] });
    expect(model.tx.inputEvent.findMany).toHaveBeenCalledWith({
      where: { worldId: model.world.id, sequence: { lte: 0 } },
      orderBy: { sequence: 'asc' },
    });
  });

  it('E5 틀린 정적 선택·descriptor·생성 해시·initial 구조를 수출하지 않는다', async () => {
    for (const change of [
      (model: ReturnType<typeof exportFixture>) => {
        model.world.treatyFormat = null;
      },
      (model: ReturnType<typeof exportFixture>) => {
        const origin = clone(off.origin);
        origin.capabilities.ext = {};
        model.world.replayOrigin = JSON.parse(JSON.stringify(origin));
      },
      (model: ReturnType<typeof exportFixture>) => {
        const origin = clone(off.origin);
        origin.initialStateHash = 'wrong';
        model.world.replayOrigin = JSON.parse(JSON.stringify(origin));
      },
      (model: ReturnType<typeof exportFixture>) => {
        const origin = clone(off.origin);
        Object.assign(origin.initial.cities[0]!, { extra: 1 });
        origin.initialStateHash = hashState(origin.initial);
        model.world.replayOrigin = JSON.parse(JSON.stringify(origin));
      },
    ]) {
      const model = exportFixture(off);
      change(model);
      await expect(exportReplay(model.db, model.world.id)).rejects.toThrow();
    }
  });

  it('E6 미완료·종료 뒤 APPLIED·잘못된 afterEnd tick과 월 coverage를 수출하지 않는다', async () => {
    const pending = exportFixture(off);
    pending.events[0]!.status = 'PENDING';
    await expect(exportReplay(pending.db, pending.world.id)).rejects.toThrow('완료되지');
    const applied = exportFixture(off);
    applied.events.at(-1)!.status = 'APPLIED';
    await expect(exportReplay(applied.db, applied.world.id)).rejects.toThrow('종료 뒤');
    const backwards = exportFixture(off);
    (backwards.events.at(-1)!.result as { tick: number }).tick = 0;
    await expect(exportReplay(backwards.db, backwards.world.id)).rejects.toThrow();
    const month = exportFixture(off);
    month.snapshot.months[0]!.sequence = month.snapshot.end!.sequence + 1;
    await expect(exportReplay(month.db, month.world.id)).rejects.toThrow('경계');
  });

  it('E7 직접 helper도 실제 gate로 선택을 묶고 별도 TX·가짜 선택을 받지 않는다', async () => {
    const model = exportFixture(off);
    const selection = selectWorldCapabilities(model.world);
    if (selection.kind !== 'caps') throw new Error('caps fixture가 필요합니다.');
    const tx = model.tx as unknown as Prisma.TransactionClient;
    expect(await exportCapsArchive(tx, model.world, selection)).toEqual(off);
    const foreign = clone(selection);
    foreign.origin.initial.seed = 'other-world';
    await expect(exportCapsArchive(tx, model.world, foreign)).rejects.toThrow('기능 선택');
    expect(model.transaction).not.toHaveBeenCalled();
    expect(model.tx.$transaction).not.toHaveBeenCalled();
  });

  it('E8 확장 명령을 켠 preset은 실제 resolver 가드에서 읽기 전에 거부한다', async () => {
    const preset = JSON.parse(
      await readFile(new URL('../../../resources/preset/regular.json', import.meta.url), 'utf8'),
    );
    const model = exportFixture(off);
    model.world.preset = { ...preset, commands: { general: ['fire_attack'], nation: [] } };
    await expect(exportReplay(model.db, model.world.id)).rejects.toThrow('확장 명령을 켠 월드');
    expect(model.tx.treaty.findMany).not.toHaveBeenCalled();
    expect(model.tx.yearbookSnapshot.findMany).not.toHaveBeenCalled();
  });
});
const marker = (archive: CapsArchive) => archive.inputs.find((input) => input.kind === 'system.policy.enable')!;
const expectReadFailure = (value: unknown) => expect(() => readCapsArchive(value)).toThrow();

describe('T4-03 / AC-P2-02 archive 6 순수 parser와 걷기', () => {
  it('A1 정상 off·F0·사람 T·NPC null의 12개월과 종료를 재현하고 남는 top 키를 거부한다', () => {
    for (const archive of [off, defaults, human, npc, delayed]) {
      const before = hashState(archive);
      const parsed = readCapsArchive(archive);
      expect(parsed).toEqual(archive);
      expect(parsed).not.toBe(archive);
      expect(parsed.origin.initial).not.toBe(archive.origin.initial);
      expect(replayCapsArchive(archive)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
      expect(replayCapsToEnd(archive)).toEqual(archive.end);
      expect(hashState(archive)).toBe(before);
      expectReadFailure({ ...archive, extra: true });
    }
    expect((marker(human).result as { baselineActiveTick: number }).baselineActiveTick).toBe(600);
    expect((marker(npc).result as { baselineActiveTick: null }).baselineActiveTick).toBeNull();
    for (const months of [0, -1, 1.5, 12001, NaN]) expect(() => replayCapsArchive(off, months)).toThrow();
    expect(() => replayCapsArchive(off, 13)).toThrow('부족');
  });

  it('A2 end·afterEnd 빠짐과 잘못된 종료 구조를 거부한다', () => {
    for (const key of ['end', 'afterEnd']) {
      const value = { ...off } as Record<string, unknown>;
      delete value[key];
      expectReadFailure(value);
    }
    for (const end of [
      { ...off.end!, sequence: 2147483648 },
      { ...off.end!, tick: -1 },
      { ...off.end!, reason: 'OTHER' },
      { ...off.end!, winnerNationId: 1 },
      { ...off.end!, extra: 0 },
    ])
      expectReadFailure({ ...off, end });
    expectReadFailure({ ...off, end: null });
    expect(() => replayCapsToEnd({ ...off, end: null, afterEnd: [] })).toThrow('종료 기록');
  });

  it('A3 config의 남는 키와 범위를 거부한다', () => {
    for (const config of [
      { ...off.config, extra: 1 },
      { ...off.config, endYear: 190 },
      { ...off.config, outcomeFromSequence: -1 },
    ])
      expectReadFailure({ ...off, config });
    const cutoff = clone(off);
    cutoff.config.outcomeFromSequence = cutoff.end!.sequence;
    expect(() => replayCapsToEnd(cutoff)).toThrow('종료 사건');
  });

  it('A4 잘못된 policy와 사람·NPC 활동 기준 뒤바꿈을 거부한다', () => {
    for (const policy of [
      null,
      {},
      { version: 2, fromSequence: 0, turnTermMinutes: 30 },
      { version: 1, fromSequence: -1, turnTermMinutes: 30 },
      { version: 1, fromSequence: 0, turnTermMinutes: 0 },
    ])
      expectReadFailure({ ...off, config: { ...off.config, policy } });
    for (const original of [human, npc]) {
      const value = clone(original);
      const result = marker(value).result as { baselineActiveTick: number | null };
      result.baselineActiveTick = result.baselineActiveTick === null ? 600 : null;
      expect(() => replayCapsArchive(value, 1)).toThrow();
    }
  });

  it('A5 archive6에서 origin1로 돌아가지 않는다', () => {
    expectReadFailure({ ...off, origin: { ...off.origin, version: 1 } });
  });

  it('A6 기존 archive2·5 parser는 origin6을 계속 거부한다', () => {
    for (const version of [2, 5]) expect(() => legacyReplay({ ...off, version }, 1)).toThrow('버전');
    expect(legacyReplay(off, 1)).toEqual(replayCapsArchive(off, 1));
    expect(replayToEnd(off)).toEqual(replayCapsToEnd(off));
  });

  it('A7 descriptor의 남는 키와 version2를 거부한다', () => {
    for (const capabilities of [
      { ...off.origin.capabilities, extra: {} },
      { version: 2, treaty: { version: 1 } },
      { version: 1, treaty: { version: 2 } },
    ])
      expectReadFailure({ ...off, origin: { ...off.origin, capabilities } });
  });

  it('A8 ext descriptor는 운반 뒤 실행 선택에서 거부한다', () => {
    const value = clone(off);
    value.origin.capabilities.ext = { opaque: { value: 1 } };
    value.origin.resourceHash = hashState(capsResourceHashInput(value.origin));
    expect(parseCapsOrigin(value.origin)).toEqual(value.origin);
    expect(() => readCapsArchive(value)).toThrow('기능 조합');
  });

  it('A9 initialStateHash 조작을 거부한다', () => {
    const value = clone(off);
    value.origin.initialStateHash = 'wrong';
    expect(() => readCapsArchive(value)).toThrow('해시');
  });

  it('A10 descriptor를 뺀 resourceHash는 맞는 해시가 아니다', () => {
    const value = clone(off);
    const { capabilities, ...withoutDescriptor } = capsResourceHashInput(value.origin);
    expect(capabilities).toEqual(value.origin.capabilities);
    value.origin.resourceHash = hashState(withoutDescriptor);
    expect(() => readCapsArchive(value)).toThrow('자원 해시');
  });

  it('A11 월 tick·연월·sequence·coverage와 전역 입력 순서를 거부한다', () => {
    for (const change of [
      (a: CapsArchive) => {
        a.months[0]!.tick++;
      },
      (a: CapsArchive) => {
        a.months[0]!.year++;
      },
      (a: CapsArchive) => {
        a.months[0]!.sequence = 1;
      },
      (a: CapsArchive) => {
        a.months[1]!.sequence = a.months[0]!.sequence;
      },
      (a: CapsArchive) => {
        a.inputs.reverse();
      },
      (a: CapsArchive) => {
        a.inputs[1]!.sequence = a.end!.sequence + 1;
      },
      (a: CapsArchive) => {
        a.afterEnd[0]!.sequence = a.end!.sequence;
      },
    ]) {
      const value = clone(off);
      change(value);
      expectReadFailure(value);
    }
    const wrongOrder = clone(off);
    wrongOrder.months[0]!.sequence++;
    expect(() => replayCapsArchive(wrongOrder, 1)).toThrow('정산 순서');
  });

  it('A12 월 stateHash·Yearbook 모양과 값을 검사하고 요청한 달까지만 해시를 비교한다', () => {
    const value = clone(off);
    value.months[5]!.stateHash = 'wrong';
    expect(replayCapsArchive(value, 1)).toHaveLength(1);
    expect(() => replayCapsArchive(value, 6)).toThrow('월간 해시');
    const book = clone(off);
    book.months[0]!.data.nations[0]!.gold++;
    expect(() => replayCapsArchive(book, 1)).toThrow('월간 해시');
    const shape = clone(off);
    Object.assign(shape.months[0]!.data, { extra: [] });
    expectReadFailure(shape);
  });

  it('A13 finalStateHash와 종료 사건의 tick·사유·연월을 비교한다', () => {
    for (const end of [
      { ...off.end!, finalStateHash: 'wrong' },
      { ...off.end!, year: off.end!.year + 1 },
      { ...off.end!, tick: off.end!.tick + 1 },
      { ...off.end!, reason: 'UNIFIED' as const, winnerNationId: 1 },
    ])
      expect(() => replayCapsToEnd({ ...off, end })).toThrow('종료 사건');
    const unified = clone(off);
    const initial = unified.origin.initial;
    initial.nations = initial.nations.slice(0, 1);
    initial.cities.forEach((city) => {
      city.nationId = 1;
    });
    initial.generals.forEach((general) => {
      general.nationId = 1;
    });
    initial.diplomacies = [];
    unified.origin.initialStateHash = hashState(initial);
    unified.inputs = [];
    unified.months = [];
    const selected = selectSupportedCapabilities(unified.origin, unified.config);
    const start = startCapsReplay(unified.origin, selected);
    const action = nextGameAction(start);
    const next = runCapsReplayAction(start, initial.seed, initial.unitSet, selected);
    unified.end = {
      sequence: 1,
      tick: action.tick,
      reason: 'UNIFIED',
      winnerNationId: 1,
      year: initial.startYear,
      month: 1,
      finalStateHash: hashState(next),
    };
    expect(replayCapsToEnd(unified)).toEqual(unified.end);
  });

  it('A14 afterEnd APPLIED·낮은 tick·틀린 거절 code를 건너뛰지 않는다', () => {
    for (const change of [
      (a: CapsArchive) => {
        a.afterEnd[0]!.status = 'APPLIED';
      },
      (a: CapsArchive) => {
        (a.afterEnd[0]!.result as { tick: number }).tick = a.end!.tick - 1;
      },
      (a: CapsArchive) => {
        (a.afterEnd[0]!.result as { code: string }).code = 'BAD_INPUT';
      },
    ]) {
      const value = clone(off);
      change(value);
      expectReadFailure(value);
    }
  });

  it('A15 표지 없음·둘·다른 sequence·coverage 밖과 F0 표지를 거부한다', () => {
    const missing = clone(human);
    missing.inputs = missing.inputs.filter((input) => input.kind !== 'system.policy.enable');
    expectReadFailure(missing);
    const twice = clone(human);
    twice.inputs.push(clone(marker(twice)));
    expectReadFailure(twice);
    const wrong = clone(human);
    marker(wrong).sequence++;
    expectReadFailure(wrong);
    const outside = clone(human);
    outside.config.policy!.fromSequence = outside.end!.sequence + 1;
    expectReadFailure(outside);
    const zero = clone(human);
    zero.config.policy!.fromSequence = 0;
    expectReadFailure(zero);
    const future = clone(off);
    future.config.policy = { version: 1, fromSequence: future.end!.sequence + 1, turnTermMinutes: 30 };
    expect(replayCapsArchive(future, 1)).toHaveLength(1);
  });

  it('A16 표지 직전 손대지 않은 장수 집합과 마지막 행동 시계를 확인한다', () => {
    const wrongSet = clone(delayed);
    const input = marker(wrongSet);
    (input.payload as { emptySlots: number[] }).emptySlots = [1, 3];
    (input.result as { emptySlots: number[] }).emptySlots = [1, 3];
    expect(() => replayCapsArchive(wrongSet, 2)).toThrow('칸 집합');
    const wrongClock = clone(delayed);
    Object.assign(marker(wrongClock).result as object, { clockTick: 0, baselineActiveTick: 0 });
    expect(() => replayCapsArchive(wrongClock, 2)).toThrow('시계');
  });

  it('A17 조약 APPLIED result 재계산과 record tick 역행을 검사한다', () => {
    const changed = clone(off);
    (changed.inputs[1]!.result as { cost: { from: number } }).cost.from++;
    expect(() => replayCapsArchive(changed, 1)).toThrow('기록과 다릅니다');
    const backwards = clone(off);
    (backwards.inputs[0]!.result as { tick: number }).tick = 10;
    (backwards.inputs[0]!.result as { respondByTick: number }).respondByTick += 10;
    expect(() => replayCapsArchive(backwards, 1)).toThrow('되돌아갑니다');
  });

  it('A18 모르는 kind의 REJECTED도 거부한다', () => {
    for (const kind of ['treaty.break', 'unknown', 'toString', '__proto__']) {
      const value = clone(off);
      Object.assign(value.inputs[0]!, { kind, status: 'REJECTED' });
      expectReadFailure(value);
    }
  });

  it('A19 treaty 없는 origin6은 무손실 운반만 되고 실행되지 않는다', () => {
    const value = clone(off);
    value.origin.capabilities = { version: 1, ext: { future: ['opaque'] } };
    value.origin.resourceHash = hashState(capsResourceHashInput(value.origin));
    const transported = parseCapsOrigin(value.origin);
    expect(transported).toEqual(value.origin);
    expect(transported).not.toBe(value.origin);
    expect(() => readCapsArchive(value)).toThrow('기능 조합');
  });

  it('A20 인사 kind와 personnel descriptor를 조약 형식으로 실행하지 않는다', () => {
    const input = clone(off);
    Object.assign(input.inputs[0]!, { kind: 'personnel.appoint', status: 'REJECTED' });
    expectReadFailure(input);
    const descriptor = clone(off);
    descriptor.origin.capabilities.personnel = {};
    descriptor.origin.resourceHash = hashState(capsResourceHashInput(descriptor.origin));
    expect(() => readCapsArchive(descriptor)).toThrow('기능 조합');
  });

  it('A21 해시를 다시 맞춘 잘못된 initial도 투영 전에 strict schema로 거부한다', () => {
    const changes: ((initial: CapsOrigin['initial']) => void)[] = [
      (i) => {
        Object.assign(i, { extra: 1 });
      },
      (i) => {
        delete (i as Partial<typeof i>).seed;
      },
      (i) => {
        Object.assign(i.cities[0]!, { extra: 1 });
      },
      (i) => {
        Object.assign(i.nations[0]!, { gold: '100' });
      },
      (i) => {
        i.generals[0]!.id = i.generals[1]!.id;
      },
      (i) => {
        i.cities[0]!.cityKey = 1.5;
      },
      (i) => {
        i.generals[0]!.nextTurnTick = Number.MAX_SAFE_INTEGER + 1;
      },
      (i) => {
        i.statRules.total = 0;
      },
      (i) => {
        Object.assign(i.statRules, { extra: 1 });
      },
      (i) => {
        Object.assign(i.unitSet, { extra: 1 });
      },
      (i) => {
        Object.assign(i.unitSet.crewTypes[0]!, { extra: 1 });
      },
      (i) => {
        Object.assign(i, { commandMeta: { nextNationId: 3, offers: {}, extra: 1 } });
      },
      (i) => {
        Object.assign(i, { nationTurns: { '1': [{ commandKey: 'rest', args: {}, extra: 1 }] } });
      },
      (i) => {
        i.generals[0]!.cityKey = 999999;
      },
    ];
    for (const change of changes) {
      const value = clone(off);
      change(value.origin.initial);
      value.origin.initialStateHash = hashState(value.origin.initial);
      value.origin.resourceHash = hashState(capsResourceHashInput(value.origin));
      expectReadFailure(value);
    }
    const valid = clone(off);
    valid.origin.initial.cities[0]!.x = 1.25;
    valid.origin.initial.nations[0]!.tech = 1.2;
    valid.origin.initial.unitSet.crewTypes[0]!.attackCoef = { '1': 1.2 };
    valid.origin.initial.commandMeta = { nextNationId: 3, offers: { '1': 2 } };
    valid.origin.initial.nationTurns = { '1': [{ commandKey: 'rest', args: { fraction: 1.2 } }] };
    valid.origin.initialStateHash = hashState(valid.origin.initial);
    valid.origin.resourceHash = hashState(capsResourceHashInput(valid.origin));
    expect(readCapsArchive(valid).origin.initial).toEqual(valid.origin.initial);
    const hidden = clone(off);
    Object.defineProperty(hidden.origin.initial, 'hidden', { value: 1 });
    expectReadFailure(hidden);
    const getter = clone(off);
    Object.defineProperty(getter.origin.initial, 'seed', {
      get() {
        throw new Error('getter must not run');
      },
      enumerable: true,
    });
    expectReadFailure(getter);
    const ext = clone(off);
    Object.assign(ext.origin.initial, { ext: {} });
    expectReadFailure(ext);
    const treaty = clone(off);
    Object.assign(treaty.origin.initial, { treaties: [] });
    expectReadFailure(treaty);
    const malformed = clone(off);
    Object.assign(malformed.origin.initial, { presetRules: { protection: {}, npc: {}, boost: {} } });
    expectReadFailure(malformed);
  });
});
