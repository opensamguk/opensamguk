import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Prisma } from '@opensamguk/db';
import * as rules from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { exportReplay, readArchive, resourceHashV3, type ReplayArchiveV3, replayArchive, replayToEnd } from './replay';
import { loadReplayState } from './monthly';
import { prepareInitialWorld } from './world/persistence';
import { endYearArchive, recordedArchive, rejectedInput, unifiedArchive } from '../test/replayFixture';
import { monthlyFixture } from '../test/monthlyFixture';
import { exportDatabase } from '../test/replayFeaturesFixture';
import { storedReaders } from '../test/storedFixture';

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const golden = async (): Promise<ReplayArchiveV3> =>
  JSON.parse(await readFile(new URL('../test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'));
it('AC-INT-28 five-stat NPC limits are checked at creation and replay', async () => {
  const initial = await monthlyFixture();
  initial.generals[0]!.leadership = 101;
  expect(() => prepareInitialWorld(initial, { name: 'limits', turnTermMinutes: 60, endYear: null })).toThrow();
  expect(() => recordedArchive(initial, 0)).toThrow();
});

async function adminEndArchive(features: string[] = []): Promise<ReplayArchiveV3> {
  const initial = await monthlyFixture();

  const origin: rules.ReplayOriginV3 = {
    version: 3,
    initial,
    initialStateHash: hashState(initial),
    resourceHash: '',
    featureData: rules.providedRuleData(initial, 60),
  };
  if (features.includes('policy')) origin.featureData = rules.providedRuleData(initial, 60);
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
        fogOfWar: initial.fogOfWar ?? false,
        name: '확인',
        scenarioKey: initial.scenarioKey,
        mapKey: initial.mapKey,
        unitSetKey: initial.unitSetKey,
        presetKey: null,
        presetHash: null,
        turnTermMinutes: 30,
        endYear: null,

        featureDataHash: hashState(archive.origin.featureData),
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
    const world = { replayFormat: 3, replayOrigin: value.origin };
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
        version: 3,
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

describe('AC-M1-14 format3 archive boundaries', () => {
  it('verifies generated twelve-month hashes after JSON round trip', async () => {
    const archive = await golden();
    expect(replayArchive(roundTrip(archive))).toEqual(
      archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })),
    );
  });
  it.each([0, 4, -1, '2', null])('rejects unsupported archive version %s', async (version) => {
    const archive = await golden();
    expect(() => readArchive({ ...archive, version })).toThrow();
  });
  it('rejects origin version mismatch and missing envelope fields', async () => {
    const archive = await golden();
    for (const version of [0, 2, undefined])
      expect(() => readArchive({ ...archive, origin: { ...archive.origin, version } })).toThrow();
    for (const key of ['config', 'end', 'afterEnd']) {
      const broken = roundTrip(archive) as unknown as Record<string, unknown>;
      delete broken[key];
      expect(() => readArchive(broken)).toThrow();
    }
  });
  it('rejects invalid config and input ordering', async () => {
    const archive = await golden();
    for (const config of [
      null,
      {},
      { endYear: null, outcomeFromSequence: -1 },
      { endYear: 10001, outcomeFromSequence: 0 },
    ])
      expect(() => readArchive({ ...archive, config })).toThrow();
    for (const inputs of [
      [rejectedInput(0)],
      [rejectedInput(2), rejectedInput(1)],
      [rejectedInput(1), rejectedInput(1)],
      [{ ...rejectedInput(1), status: 'PENDING' }],
    ])
      expect(() => readArchive({ ...archive, inputs })).toThrow();
  });
  it('monthly replay validates only requested months', async () => {
    const archive = await endYearArchive();
    archive.months[5]!.stateHash = 'bad';
    archive.end!.finalStateHash = 'bad';
    expect(replayArchive(archive, 1)).toHaveLength(1);
    expect(() => replayArchive(archive, 6)).toThrow();
  });
  it.each([10_000_001, 2_147_483_647, 2_147_483_648])(
    'validates monthly sequence %s against actual order and DB Int bounds',
    async (sequence) => {
      const archive = await golden();
      archive.months[0]!.sequence = sequence;
      expect(() => replayArchive(archive, 1)).toThrow();
    },
  );
  it.each([false, true])('replays unified terminal afterMonth=%s', async (afterMonth) => {
    const archive = await unifiedArchive(afterMonth);
    expect(archive.months.length > 0).toBe(afterMonth);
    expect(replayToEnd(roundTrip(archive))).toEqual(archive.end);
    for (let index = 0; index < archive.inputs.length; index++) {
      const broken = roundTrip(archive);
      broken.inputs.splice(index, 1);
      expect(() => replayToEnd(broken)).toThrow();
    }
  });
  it('ends at December settlement before another action at the same tick', async () => {
    const archive = await endYearArchive();
    expect(archive.end).toMatchObject({
      tick: 120000,
      reason: 'END_YEAR',
      month: 12,
      finalStateHash: archive.months[11]!.stateHash,
    });
    const run = vi.spyOn(rules, 'runArchiveReplayAction');
    expect(replayToEnd(roundTrip(archive))).toEqual(archive.end);
    expect(run).toHaveBeenCalledTimes(archive.end!.sequence);
  });
  it('afterEnd rejected inputs are validated without applying them', async () => {
    const archive = await endYearArchive();
    const at = archive.end!.sequence;
    archive.afterEnd = [rejectedInput(at + 1), rejectedInput(at + 3)];
    const apply = vi.spyOn(rules, 'applyRecordedInput');
    expect(replayToEnd(archive)).toEqual(archive.end);
    expect(apply).not.toHaveBeenCalled();
    for (const afterEnd of [
      [rejectedInput(at)],
      [rejectedInput(at + 2), rejectedInput(at + 1)],
      [{ ...rejectedInput(at + 1), status: 'APPLIED' }],
    ])
      expect(() => readArchive({ ...archive, afterEnd })).toThrow();
  });
  it.each(['tick', 'year', 'month', 'reason', 'winnerNationId', 'finalStateHash', 'sequence'])(
    'rejects modified terminal %s',
    async (key) => {
      const archive = await endYearArchive();
      const end = archive.end as unknown as Record<string, unknown>;
      end[key] = key === 'reason' ? 'UNIFIED' : key === 'finalStateHash' ? 'bad' : -1;
      expect(() => replayToEnd(archive)).toThrow();
    },
  );
  it.each(['missing', 'extra', 'order', 'tick', 'year', 'data'])('rejects monthly corruption %s', async (kind) => {
    const archive = await endYearArchive();
    if (kind === 'missing') archive.months.splice(2, 1);
    if (kind === 'extra') archive.months.push({ ...archive.months.at(-1)!, sequence: archive.end!.sequence + 1 });
    if (kind === 'order') archive.months[0]!.sequence++;
    if (kind === 'tick') archive.months[0]!.tick++;
    if (kind === 'year') archive.months[0]!.year++;
    if (kind === 'data') archive.months[0]!.data.nations = [];
    expect(() => replayToEnd(archive)).toThrow();
  });
  it('exports current creation and terminal without changing the archive', async () => {
    const expected = await endYearArchive();
    expect(await exportReplay(exportDatabase(expected).db, 'baseline')).toEqual(expected);
  });
  it('export rejects missing creation and applied afterEnd inputs', async () => {
    const expected = await endYearArchive();
    expected.afterEnd = [{ ...rejectedInput(expected.end!.sequence + 1), status: 'APPLIED' }];
    await expect(exportReplay(exportDatabase(expected).db, 'baseline')).rejects.toThrow();
  });
  it('initial and loaded replay retain the complete current state', async () => {
    const initial = await monthlyFixture();
    const tx = storedReaders(initial, 'shape-test');
    const actual = await loadReplayState(tx as unknown as Prisma.TransactionClient, 'shape-test');
    const expected = rules.initialReplayState(initial);
    expect(actual).toEqual(expected);
    expect(hashState(actual)).toBe(hashState(expected));
  });
});
