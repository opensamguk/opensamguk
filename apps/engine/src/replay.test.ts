import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import * as rules from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import {
  exportReplay,
  readArchive,
  resourceHashV3,
  type ReplayArchiveV3,
  replayArchive,
  replayToEnd,
  type ReplayArchive,
  type ReplayArchiveV2,
  type ReplayArchiveV5,
} from './replay';
import { loadReplayState } from './monthly';
import { endYearArchive, recordedArchive, rejectedInput, unifiedArchive } from '../test/replayFixture';
import { monthlyFixture } from '../test/monthlyFixture';

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const golden = async (): Promise<ReplayArchive> =>
  JSON.parse(await readFile(new URL('../test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'));
const asV2 = (archive: ReplayArchive): ReplayArchiveV2 => ({
  ...archive,
  version: 2,
  config: { endYear: null, outcomeFromSequence: 0 },
  end: null,
  afterEnd: [],
});

async function adminEndArchive(features: string[] = []): Promise<ReplayArchiveV3> {
  const initial = await monthlyFixture();
  if (features.length) initial.ruleFeatures = features;
  const origin: rules.ReplayOriginV3 = { version: 3, initial, initialStateHash: hashState(initial), resourceHash: '' };
  if (features.includes('policy')) origin.featureData = { policy: { version: 1, turnTermMinutes: 60 } };
  origin.resourceHash = resourceHashV3(origin);
  const finalStateHash = hashState(
    rules.initialReplayStateWithRegistry(initial, rules.ruleRegistry, origin.featureData),
  );
  return {
    version: 3,
    origin,
    config: { endYear: null, outcomeFromSequence: 0 },
    months: [],
    afterEnd: [],
    inputs: [
      {
        sequence: 1,
        tick: 0,
        generalId: null,
        kind: rules.ADMIN_END_KIND,
        status: 'APPLIED',
        payload: { version: 1, confirmName: '확인', expectedRevision: 2, reason: '종료' },
        result: {
          version: 1,
          before: { status: 'PAUSED', tick: 0, revision: 2 },
          after: { status: 'ENDED', tick: 0, revision: 3 },
          at: '2026-10-29T00:00:00.000Z',
          finalStateHash,
        },
      },
    ],
    end: {
      sequence: 1,
      tick: 0,
      reason: 'ADMIN_END',
      winnerNationId: null,
      ...rules.toGameDate(initial.startYear, 0),
      finalStateHash,
    },
  };
}

async function adminResetArchive(): Promise<ReplayArchiveV3> {
  const archive = await adminEndArchive(),
    initial = archive.origin.initial,
    source = '00000000-0000-4000-8000-000000000001',
    target = '00000000-0000-4000-8000-000000000002';
  const resources = (['MAP', 'PORTRAIT_MAP', 'SCENARIO', 'STAT_RULES', 'UNIT_SET'] as const).map((kind) => ({
    kind,
    name:
      kind === 'MAP'
        ? initial.mapKey
        : kind === 'SCENARIO'
          ? initial.scenarioKey
          : kind === 'UNIT_SET'
            ? initial.unitSetKey
            : 'fixture',
    version: 1,
    contentHash: 'a'.repeat(64),
  }));
  archive.inputs[0] = {
    ...archive.inputs[0]!,
    kind: rules.ADMIN_RESET_KIND,
    payload: {
      version: 1,
      sourceWorldId: source,
      plannedNewWorldId: target,
      effectiveSeed: 'new',
      intent: { confirmName: '확인', expectedRevision: 2, reason: '초기화', requestedSeed: 'new' },
    },
    result: {
      ...(archive.inputs[0]!.result as object),
      sourceWorldId: source,
      newWorldId: target,
      effectiveSeed: 'new',
      sourceInitialHash: archive.origin.initialStateHash,
      sourceResourceHash: archive.origin.resourceHash,
      sourceSettingsHash: 'b'.repeat(64),
      newInitialHash: hashState({ ...initial, seed: 'new' }),
      newResourceHash: archive.origin.resourceHash,
      newSettingsHash: 'c'.repeat(64),
      resources,
      settings: {
        name: '확인',
        scenarioKey: initial.scenarioKey,
        mapKey: initial.mapKey,
        unitSetKey: initial.unitSetKey,
        presetKey: null,
        presetHash: null,
        turnTermMinutes: 30,
        endYear: null,
        ruleFeatures: [],
        featureDataHash: hashState(null),
      },
    },
  };
  archive.end = { ...archive.end!, reason: 'ADMIN_RESET', winnerNationId: null };
  return archive;
}
describe('ADMIN-RESET AC-M3-04 원본 terminal 재생', () => {
  it('월간0건·승자null 원본의 동일 해시를 두 번 재생하며 새 월드는 합치지 않는다', async () => {
    const archive = await adminResetArchive(),
      before = roundTrip(archive.origin.initial);
    expect(readArchive(archive)).toBe(archive);
    expect(replayToEnd(archive)).toEqual(archive.end);
    expect(replayToEnd(roundTrip(archive))).toEqual(archive.end);
    expect(archive.origin.initial).toEqual(before);
  });
  it('payload/target·원초기·자원·설정 매핑 변조는 기록 읽기에서 거부한다', async () => {
    const value = await adminResetArchive(),
      result = value.inputs[0]!.result as Record<string, unknown>;
    for (const delta of [
      { newWorldId: '00000000-0000-4000-8000-000000000003' },
      { effectiveSeed: 'wrong' },
      { sourceInitialHash: 'a'.repeat(64) },
      { sourceResourceHash: 'a'.repeat(64) },
      { settings: { ...(result.settings as object), mapKey: 'other' } },
      { settings: { ...(result.settings as object), endYear: 200 } },
      { settings: { ...(result.settings as object), featureDataHash: 'c'.repeat(64) } },
    ]) {
      const changed = roundTrip(value);
      changed.inputs[0]!.result = { ...result, ...delta };
      expect(() => readArchive(changed)).toThrow();
    }
  });
  it('다중 reset/END terminal과 구형식은 거부하고 기존 END를 보존한다', async () => {
    const value = await adminResetArchive(),
      old = await adminEndArchive();
    for (const kind of [rules.ADMIN_RESET_KIND, rules.ADMIN_END_KIND]) {
      const changed = roundTrip(value);
      changed.afterEnd.push({ ...old.inputs[0]!, kind, sequence: 2 });
      expect(() => readArchive(changed)).toThrow();
    }
    for (const version of [1, 2, 5]) expect(() => readArchive({ ...value, version })).toThrow();
    expect(replayToEnd(old)).toEqual(old.end);
  });
  it('유효hash·연월을 함께 바꿔도 앞선 입력 tick의 역행 cutoff는 거부한다', async () => {
    const value = await adminResetArchive(),
      terminal = value.inputs[0]!;
    value.inputs = [
      {
        sequence: 1,
        tick: 1,
        generalId: null,
        kind: 'admin.world.pause',
        status: 'REJECTED',
        payload: { version: 1, reason: '정지' },
        result: { code: 'WORLD_STATE_CHANGED', message: rules.adminClockRejectMessages.WORLD_STATE_CHANGED },
      },
      { ...terminal, sequence: 2 },
    ];
    value.end = { ...value.end!, sequence: 2 };
    expect(() => readArchive(value)).toThrow('경계');
    expect(() => replayToEnd(value)).toThrow('경계');
  });
  it('마지막 원본 게임 hash가 다르면 재생 성공으로 세지 않는다', async () => {
    const value = await adminResetArchive();
    value.end!.finalStateHash = 'a'.repeat(64);
    value.inputs[0]!.result = { ...(value.inputs[0]!.result as object), finalStateHash: 'a'.repeat(64) };
    expect(() => replayToEnd(value)).toThrow('해시');
  });
});

describe('ADMIN-END AC-M3-04 형식3 강제 종료', () => {
  it('원생성 상태와 자원 해시까지 대조한다', async () => {
    const value = await adminEndArchive();
    const world = { replayFormat: 3, ruleFeatures: [], replayOrigin: value.origin };
    expect(() => rules.checkAdminEndOrigin(world, rules.checkReplayOrigin, hashState)).not.toThrow();
    for (const field of ['initialStateHash', 'resourceHash'])
      expect(() =>
        rules.checkAdminEndOrigin(
          { ...world, replayOrigin: { ...value.origin, [field]: '0'.repeat(64) } },
          rules.checkReplayOrigin,
          hashState,
        ),
      ).toThrow('해시');
  });
  it.each(['policy', 'treaty', 'personnel'])('기존 %s 기능의 종료 검증도 통과한다', async (feature) => {
    const value = await adminEndArchive([feature]);
    expect(replayToEnd(value)).toEqual(value.end);
  });
  it('월간0건·승자 결과 없이 마지막 명시 입력으로 같은 해시를 재생한다', async () => {
    const value = await adminEndArchive();
    expect(readArchive(value)).toBe(value);
    expect(replayToEnd(value)).toEqual(value.end);
    expect(replayToEnd(roundTrip(value))).toEqual(value.end);
  });
  it('종료 경계와 적용 입력이 어긋나거나 구형식이면 거부한다', async () => {
    const value = await adminEndArchive();
    for (const changed of [
      { inputs: [] },
      { inputs: [value.inputs[0], { ...value.inputs[0], sequence: 2 }] },
      { end: null },
      { end: { ...value.end, reason: 'END_YEAR' } },
      { end: { ...value.end, sequence: 2 } },
      { end: { ...value.end, tick: 1 } },
      { end: { ...value.end, year: 0 } },
      { end: { ...value.end, winnerNationId: 1 } },
      { end: { ...value.end, extra: true } },
      { extra: true },
      {
        version: 2,
        origin: { ...value.origin, version: 1 },
        inputs: value.inputs.map((input) =>
          Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'tick')),
        ),
      },
      { afterEnd: [{ ...value.inputs[0], sequence: 2 }] },
    ])
      expect(() => replayToEnd({ ...value, ...changed })).toThrow();
  });
  it('기록과 외피의 해시를 함께 조작해도 실제 재생 해시로 거부한다', async () => {
    const value = await adminEndArchive();
    value.end!.finalStateHash = 'b'.repeat(64);
    (value.inputs[0]!.result as Record<string, unknown>).finalStateHash = value.end!.finalStateHash;
    expect(() => replayToEnd(value)).toThrow('해시');
  });
  it.each(['direct-rejected', 'direct-applied', 'queued-rejected'] as const)(
    '%s 입력의 처리 tick보다 종료 경계를 과거로 옮기면 거부한다',
    async (kind) => {
      const value = await adminEndArchive();
      const tick = kind === 'queued-rejected' ? 1 : rules.TICKS_PER_MONTH;
      const ending = value.inputs[0]!;
      ending.sequence = 2;
      ending.tick = tick;
      const applied = ending.result as {
        before: { tick: number };
        after: { tick: number };
        finalStateHash: string;
      };
      applied.before.tick = tick;
      applied.after.tick = tick;
      value.end = { ...value.end!, sequence: 2, tick, ...rules.toGameDate(value.origin.initial.startYear, tick) };
      value.inputs.unshift({
        sequence: 1,
        tick,
        generalId: null,
        kind: kind === 'queued-rejected' ? 'general.active' : 'admin.world.pause',
        status: kind === 'direct-applied' ? 'APPLIED' : 'REJECTED',
        payload: kind === 'queued-rejected' ? {} : { version: 1, reason: '운영 점검' },
        result:
          kind === 'direct-applied'
            ? {
                version: 1,
                before: { status: 'RUNNING', tick, revision: 0 },
                after: { status: 'PAUSED', tick, revision: 1 },
                at: '2026-10-29T00:00:00.000Z',
              }
            : kind === 'queued-rejected'
              ? { code: 'FEATURE_DISABLED', message: '이 판에서 지원하지 않는 기능입니다.' }
              : { code: 'WORLD_STATE_CHANGED', message: rules.adminClockRejectMessages.WORLD_STATE_CHANGED },
      });
      expect(readArchive(value)).toBe(value);
      expect(replayToEnd(value)).toEqual(value.end);
      // 상태를 바꾸지 않는 앞선 입력은 같은 최종 해시를 낸다. 연월과 내·외피 해시까지 맞춰도 tick 역행은 거부한다.
      ending.tick = 0;
      applied.before.tick = 0;
      applied.after.tick = 0;
      applied.finalStateHash = value.end.finalStateHash;
      value.end = { ...value.end, tick: 0, ...rules.toGameDate(value.origin.initial.startYear, 0) };
      expect(() => readArchive(value)).toThrow('경계');
      expect(() => replayToEnd(value)).toThrow('경계');
    },
  );
});

afterEach(() => vi.restoreAllMocks());

describe('T1-26 재생 보관 형식', () => {
  it('b8f5074의 v1 골든 12개월을 저장된 해시 그대로 검증한다', async () => {
    const archive = await golden();
    expect(archive.origin.initial.generals.every((general) => general.userId === null)).toBe(true);
    expect(replayArchive(archive)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
    expect(archive.months.at(-1)!.stateHash).toBe('d60ad5f09185a889fc64926efe4e367e1b909710b227e76e3005698e71d80a0b');
  });

  it('종료 기록 없는 v2를 JSON으로 주고받아도 v1의 월간 해시와 같다', async () => {
    const archive = await golden();
    expect(replayArchive(roundTrip(asV2(archive)))).toEqual(replayArchive(archive));
  });

  it.each([0, 3, -1, '2', null])('알 수 없는 archive 버전 %s를 거부한다', async (version) => {
    const archive = await golden();
    expect(() => replayArchive({ ...archive, version }, 1)).toThrow();
  });

  it('origin 버전과 v1·v2 혼합 키를 거부한다', async () => {
    const archive = await golden();
    for (const originVersion of [0, 2, undefined]) {
      for (const value of [archive, asV2(archive)]) {
        expect(() => replayArchive({ ...value, origin: { ...value.origin, version: originVersion } }, 1)).toThrow(
          '버전',
        );
      }
    }
    for (const key of ['config', 'end', 'afterEnd']) {
      expect(() => replayArchive({ ...archive, [key]: undefined }, 1)).toThrow('버전');
      const v2: Record<string, unknown> = { ...asV2(archive) };
      delete v2[key];
      expect(() => replayArchive(v2, 1)).toThrow('버전');
    }
  });

  it('v2 설정·입력 순서·끝 번호를 검사한다', async () => {
    const archive = asV2(await golden());
    for (const config of [
      null,
      {},
      { endYear: undefined, outcomeFromSequence: 0 },
      { endYear: null, outcomeFromSequence: -1 },
      { endYear: 10001, outcomeFromSequence: 0 },
    ]) {
      expect(() => replayArchive({ ...archive, config }, 1)).toThrow();
    }
    for (const inputs of [
      [rejectedInput(0)],
      [rejectedInput(2), rejectedInput(1)],
      [rejectedInput(1), rejectedInput(1)],
      [{ ...rejectedInput(1), status: 'PENDING' }],
    ]) {
      expect(() => replayArchive({ ...archive, inputs }, 1)).toThrow('순서');
    }
    const ended = await unifiedArchive();
    ended.inputs.push(rejectedInput(ended.end!.sequence + 1));
    expect(() => replayToEnd(ended)).toThrow('입력');
  });

  it('v1은 종료 판정을 하지 않고 v2는 cutoff 이후 사건부터 판정한다', async () => {
    const initial = await monthlyFixture();
    initial.nations = initial.nations.slice(0, 1);
    initial.cities.forEach((city) => {
      city.nationId = 1;
    });
    initial.generals.forEach((general) => {
      general.nationId = 1;
    });
    initial.diplomacies = [];
    const v2 = recordedArchive(initial, 3);
    const v1: ReplayArchive = { version: 1, origin: v2.origin, inputs: v2.inputs, months: v2.months };
    expect(replayArchive(v1, 1)).toHaveLength(1);
    expect(() => replayArchive(v2, 1)).toThrow('먼저');
    v2.config.outcomeFromSequence = 3;
    expect(replayArchive(v2, 1)).toHaveLength(1);
    const ended = recordedArchive(initial, 4, [], 'UNIFIED');
    ended.config.outcomeFromSequence = 3;
    expect(replayToEnd(ended)).toEqual(ended.end);
    ended.config.outcomeFromSequence = 4;
    expect(() => replayToEnd(ended)).toThrow('종료 사건');
  });

  it('v2 월간 재생도 요청한 개월까지만 검사한다', async () => {
    const archive = await endYearArchive();
    archive.months[5]!.stateHash = '나중 달의 손상';
    archive.end!.finalStateHash = '나중 종료의 손상';
    expect(replayArchive(archive, 1)).toHaveLength(1);
    expect(() => replayArchive(archive, 6)).toThrow('해시');
    const withoutEnd = asV2(await golden());
    withoutEnd.config.endYear = withoutEnd.origin.initial.startYear;
    expect(replayArchive(withoutEnd, 11)).toHaveLength(11);
    expect(() => replayArchive(withoutEnd, 12)).toThrow('먼저');
  });

  it('v2 월간 번호는 DB Int 범위이며 v1의 1천만 상한은 보존한다', async () => {
    const legacy = await golden();
    legacy.months[0]!.sequence = 10_000_001;
    expect(() => replayArchive(legacy, 1)).toThrow('경계');
    for (const sequence of [10_000_001, 2_147_483_647]) {
      const current = asV2(await golden());
      current.months[0]!.sequence = sequence;
      expect(() => replayArchive(current, 1)).toThrow('정산 순서');
    }
  });

  it('v2 종료 번호는 1천만을 넘어도 유효하며 DB Int 초과만 거부한다', async () => {
    const archive = await unifiedArchive();
    for (const sequence of [10_000_001, 2_147_483_647]) {
      archive.end!.sequence = sequence;
      // 번호 형식은 통과하지만 실제 통일은 더 이른 두 번째 사건이므로 즉시 거부한다.
      expect(() => replayToEnd(archive)).toThrow('먼저 끝났습니다');
    }
    archive.end!.sequence = 2_147_483_648;
    expect(() => replayToEnd(archive)).toThrow('재생 설정');
  });

  it('v2 종료 재생의 월간 경계도 1천만 이후 번호를 형식 오류로 거부하지 않는다', async () => {
    const archive = await endYearArchive();
    archive.months[0]!.sequence = 10_000_001;
    archive.end!.sequence = 2_147_483_647;
    expect(() => replayToEnd(archive)).toThrow('정산 순서');
  });
});

describe('T1-26 종료 재생', () => {
  it.each([false, true])('마지막 도시를 얻은 턴에서 끝난다. 정산 뒤 입력: %s', async (afterMonth) => {
    const archive = await unifiedArchive(afterMonth);
    expect(archive.months).toHaveLength(afterMonth ? 1 : 0);
    expect(archive.end).toMatchObject({
      sequence: afterMonth ? 5 : 2,
      tick: afterMonth ? 10100 : 100,
      reason: 'UNIFIED',
      winnerNationId: 1,
      year: 191,
      month: afterMonth ? 2 : 1,
    });
    const next = vi.spyOn(rules, 'nextGameAction');
    const run = vi.spyOn(rules, 'runReplayAction');
    expect(replayToEnd(roundTrip(archive))).toEqual(archive.end);
    expect(next).toHaveBeenCalledTimes(archive.end!.sequence - archive.inputs.length);
    expect(run).toHaveBeenCalledTimes(archive.end!.sequence - archive.inputs.length);
    if (afterMonth) {
      expect(replayArchive(archive, 1)).toHaveLength(1);
      for (let i = 0; i < archive.inputs.length; i++) {
        const missing = roundTrip(archive);
        missing.inputs.splice(i, 1);
        expect(() => replayToEnd(missing)).toThrow();
      }
    }
  });

  it('12월 정산 해시로 끝내고 같은 tick 장수 턴이나 다음 정산을 실행하지 않는다', async () => {
    const archive = await endYearArchive();
    const end = archive.end!;
    expect(end).toMatchObject({
      sequence: 34,
      tick: 120000,
      reason: 'END_YEAR',
      winnerNationId: null,
      year: archive.origin.initial.startYear,
      month: 12,
    });
    expect(end.finalStateHash).toBe(archive.months[11]!.stateHash);
    const run = vi.spyOn(rules, 'runReplayAction');
    expect(replayToEnd(roundTrip(archive))).toEqual(end);
    expect(run).toHaveBeenCalledTimes(34);
    expect(replayArchive(archive, 12)).toHaveLength(12);
  });

  it('종료 뒤 REJECTED는 오름차순·끝 번호 초과만 검사하고 적용하지 않는다', async () => {
    const archive = await unifiedArchive();
    archive.afterEnd = [rejectedInput(5), rejectedInput(9)];
    archive.afterEnd[0]!.kind = '적용하면 실패하는 종류';
    const apply = vi.spyOn(rules, 'applyRecordedInput');
    expect(replayToEnd(archive)).toEqual(archive.end);
    expect(apply).toHaveBeenCalledTimes(archive.inputs.length);
    for (const afterEnd of [
      [rejectedInput(2)],
      [rejectedInput(1)],
      [rejectedInput(4), rejectedInput(3)],
      [rejectedInput(3), rejectedInput(3)],
      [{ ...rejectedInput(3), status: 'APPLIED' }],
    ]) {
      expect(() => replayToEnd({ ...archive, afterEnd })).toThrow('종료 뒤 입력');
    }
    const ongoing = asV2(await golden());
    ongoing.afterEnd = [rejectedInput(100)];
    expect(() => replayArchive(ongoing, 1)).toThrow('종료 뒤 입력');
  });

  it('tick·연월·사유·승자·해시·sequence 변조와 입력 번호의 종료를 거부한다', async () => {
    const archive = await unifiedArchive();
    for (const patch of [
      { tick: 101 },
      { year: 181 },
      { month: 12 },
      { reason: 'END_YEAR', winnerNationId: null },
      { winnerNationId: 2 },
      { finalStateHash: '변조' },
      { sequence: 3 },
    ]) {
      expect(() => replayToEnd({ ...archive, end: { ...archive.end, ...patch } })).toThrow();
    }
    const inputEnd = roundTrip(archive);
    inputEnd.inputs.push(rejectedInput(inputEnd.end!.sequence));
    expect(() => replayToEnd(inputEnd)).toThrow('게임 사건');
    const yearEnd = await endYearArchive();
    yearEnd.config.endYear = null;
    expect(() => replayToEnd(yearEnd)).toThrow('종료 사건');
    const ongoing = asV2(await golden());
    expect(() => replayToEnd(ongoing)).toThrow('종료 기록');
    expect(() => replayToEnd({ ...archive, version: 1 })).toThrow();
  });

  it('월간 기록 누락·추가·순서·경계·연감 변조를 거부한다', async () => {
    const archive = await endYearArchive();
    for (const mutate of [
      (value: ReplayArchiveV2) => {
        value.months.splice(2, 1);
      },
      (value: ReplayArchiveV2) => {
        value.months.push({ ...value.months.at(-1)!, sequence: 35 });
      },
      (value: ReplayArchiveV2) => {
        value.months[0]!.sequence++;
      },
      (value: ReplayArchiveV2) => {
        value.months[0]!.tick++;
      },
      (value: ReplayArchiveV2) => {
        value.months[0]!.year++;
      },
      (value: ReplayArchiveV2) => {
        value.months[0]!.data.nations = [];
      },
    ]) {
      const bad = roundTrip(archive);
      mutate(bad);
      expect(() => replayToEnd(bad)).toThrow();
    }
  });
});

function exportDatabase(archive: ReplayArchiveV2 | ReplayArchiveV5, ended = true) {
  const end = archive.end;
  const events = [...archive.inputs, ...archive.afterEnd];
  const tx = {
    world: {
      findUniqueOrThrow: vi.fn(async () => ({
        replayFormat: 1,
        ruleFeatures: [],
        replayOrigin: archive.origin,
        treatyFormat: null,
        personnelFormat: null,
        policyFromSequence: archive.version === 5 ? archive.config.policy.fromSequence : null,
        actionSequence: archive.end?.sequence ?? archive.months.at(-1)?.sequence ?? 0,
        turnTermMinutes: 30,
        ...archive.config,
      })),
    },
    worldResult: {
      findUnique: vi.fn(async () =>
        ended && end
          ? { ...end, endedSequence: end.sequence, endedTick: end.tick, endedYear: end.year, endedMonth: end.month }
          : null,
      ),
    },
    yearbookSnapshot: { findMany: vi.fn(async () => archive.months) },
    inputEvent: {
      findMany: vi.fn(async ({ where }: { where: { sequence: { lte?: number; not?: null } } }) =>
        events.filter((event) => where.sequence.lte === undefined || event.sequence <= where.sequence.lte),
      ),
    },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
  return { tx, db: { $transaction: transaction } as unknown as PrismaClient, transaction, events };
}

describe('T1-26 내보내기와 네 키 상태', () => {
  it('origin1·archive5의 F0 설정과 수출 bytes를 보존한다', async () => {
    const initial = await monthlyFixture();
    const base = recordedArchive(initial, 0);
    const expected: ReplayArchiveV5 = {
      ...base,
      version: 5,
      config: { ...base.config, policy: { version: 1, fromSequence: 0, turnTermMinutes: 30 } },
    };
    const { db } = exportDatabase(expected, false);
    const first = await exportReplay(db, 'legacy-policy');
    expect(first).toEqual(expected);
    expect(JSON.stringify(await exportReplay(db, 'legacy-policy'))).toBe(JSON.stringify(first));
  });

  it.each([false, true])('WorldResult의 끝 번호까지 입력을 내보낸다. 정산 뒤: %s', async (afterMonth) => {
    const expected = await unifiedArchive(afterMonth);
    expected.afterEnd = [rejectedInput(expected.end!.sequence + 1)];
    const { db, tx, transaction } = exportDatabase(expected);
    const archive = roundTrip(await exportReplay(db, 'replay-world'));
    expect(archive).toEqual(expected);
    expect(archive.origin.version).toBe(1);
    expect(tx.worldResult.findUnique).toHaveBeenCalledWith({ where: { worldId: 'replay-world' } });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(replayToEnd(archive)).toEqual(expected.end);
  });

  it('결과가 없으면 마지막 정산 번호까지만 내보낸다', async () => {
    const expected = asV2(await golden());
    const { db, tx, events } = exportDatabase(expected, false);
    events.push(rejectedInput(expected.months.at(-1)!.sequence + 1));
    const archive = roundTrip(await exportReplay(db, 'ongoing'));
    expect(archive).toEqual(expected);
    expect(tx.inputEvent.findMany).toHaveBeenCalledWith({
      where: { worldId: 'ongoing', sequence: { lte: expected.months.at(-1)!.sequence } },
      orderBy: { sequence: 'asc' },
    });
    expect(replayArchive(archive)).toHaveLength(12);
  });

  it('진행 중 첫 정산 전에는 입력을 내보내지 않는다', async () => {
    const expected = recordedArchive(await monthlyFixture(), 0);
    const { db, events } = exportDatabase(expected, false);
    events.push(rejectedInput(1));
    expect(await exportReplay(db, 'new')).toEqual(expected);
  });

  it('종료 뒤 APPLIED와 없는 origin을 내보내지 않는다', async () => {
    const expected = await unifiedArchive();
    expected.afterEnd = [{ ...rejectedInput(3), status: 'APPLIED' }];
    const { db } = exportDatabase(expected);
    await expect(exportReplay(db, 'invalid')).rejects.toThrow('종료 뒤');
    const missing = exportDatabase(expected);
    missing.tx.world.findUniqueOrThrow.mockResolvedValueOnce({ replayOrigin: null, ...expected.config } as never);
    await expect(exportReplay(missing.db, 'missing')).rejects.toThrow('생성 기록');
  });

  it('initialReplayState와 loadReplayState는 네 키를 그대로 반환한다', async () => {
    const initial = await monthlyFixture();
    const expected = rules.initialReplayState(initial);
    const worldId = 'shape-test';
    const withWorld = <T extends object>(rows: T[]) => rows.map((row) => ({ ...row, worldId }));
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?').trim().replace(/\s+/g, ' ');
        if (
          sql === 'SELECT "key", "value" FROM "WorldExtSlice" WHERE "worldId" = ? ORDER BY "key"' &&
          values.length === 1 &&
          values[0] === worldId
        )
          return [];
        throw new Error(`예상하지 않은 원시 조회: ${sql}`);
      },
      world: {
        findUniqueOrThrow: async () => ({
          id: worldId,
          replayFormat: 1,
          ruleFeatures: [],
          preset: null,
          treatyFormat: null,
          personnelFormat: null,
          replayOrigin: null,
          policyFromSequence: null,
          actionSequence: 0,
          turnTermMinutes: 30,
          startYear: initial.startYear,
          monthlyTick: 0,
          endYear: initial.startYear,
          clockMode: 'ACCELERATED',
          outcomeFromSequence: 77,
          commandMeta: null,
        }),
      },
      treaty: {
        findMany: async ({ where }: Prisma.TreatyFindManyArgs) => {
          if (where?.worldId !== worldId) throw new Error('예상하지 않은 조약 월드 조회입니다.');
          return [];
        },
      },
      city: { findMany: async () => withWorld(initial.cities) },
      nation: { findMany: async () => withWorld(initial.nations) },
      general: {
        findMany: async () =>
          withWorld(initial.generals).map((general) => ({ ...general, turnRevision: 0, battleWins: 0, captures: 0 })),
      },
      diplomacy: { findMany: async () => withWorld(initial.diplomacies) },
      generalTurn: { findMany: async () => [] },
      nationTurn: { findMany: async () => [] },
    } as unknown as Prisma.TransactionClient;
    const loaded = await loadReplayState(tx, worldId);
    for (const replay of [expected, loaded]) {
      expect(Object.keys(replay).sort()).toEqual(['monthlyTick', 'revisions', 'state', 'turns']);
      expect(replay).toEqual(expected);
      expect(hashState(replay)).toBe(hashState(expected));
    }
  });
});
