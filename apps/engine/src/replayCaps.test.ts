import { beforeAll, describe, expect, it } from 'vitest';
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
  type CapsOrigin,
  type RecordedInput,
  type TreatyInput,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { monthlyFixture } from '../test/monthlyFixture';
import { replayArchive as legacyReplay } from './replay';
import { readCapsArchive, replayCapsArchive, replayCapsToEnd, type CapsArchive } from './replayCaps';

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
    expect(() => legacyReplay(off, 1)).toThrow('버전');
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
