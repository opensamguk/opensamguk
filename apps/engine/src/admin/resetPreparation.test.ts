import { readFileSync } from 'node:fs';
import type { Prisma, PrismaClient, PublishedResource } from '@opensamguk/db';
import { parsePreset, worldCreateIntent, ADMIN_RESET_KIND, type ReplayOriginV3 } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { beforeAll, expect, it, vi } from 'vitest';
import { composeInitialWorld, type InitialResources } from '../world/resources';
import {
  prepareInitialWorld,
  savePreparedInitialWorld,
  type InitialWorldOptions,
  type PreparedInitialWorld,
} from '../world/persistence';
import {
  prepareWorldReset,
  ResetPreparationError,
  verifyResetPreparation,
  resetSourceSettingsHash,
  resetSettingsReference,
  type ResetPreparation,
} from './resetPreparation';

const worldId = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';
const oldSeed = 'reset-source-seed';
const controller = () => new AbortController();
const json = (path: string): unknown =>
  JSON.parse(readFileSync(new URL('../../../../' + path, import.meta.url), 'utf8'));
function resource(kind: PublishedResource['kind'], name: string, path: string): PublishedResource {
  const content = json(path);
  return { kind, name, version: 1, content, contentHash: hashState(content), source: 'repository formal fixture' };
}
const resources: InitialResources = {
  map: resource('MAP', 'integration', 'resources/map/integration.json'),
  scenario: resource('SCENARIO', 'integration191', 'resources/scenario/integration191.json'),
  unitSet: resource('UNIT_SET', 'basic', 'resources/unitset/basic.json'),
  statRules: resource('STAT_RULES', 'five-stats', 'resources/scenario/five-stats.json'),
  portraitMap: resource('PORTRAIT_MAP', '191-map', 'resources/portraits/191-map.json'),
};
const features = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'].sort();
const options: InitialWorldOptions = {
  name: '원본 정식 191년',
  turnTermMinutes: 30,
  endYear: 200,
  replayFormat: 3,
  ruleFeatures: features,
};
type World = Prisma.WorldGetPayload<Record<string, never>>;
type Request = Prisma.WorldCreateRequestGetPayload<Record<string, never>>;
type Event = Prisma.InputEventGetPayload<Record<string, never>>;
async function capture(prepared: PreparedInitialWorld) {
  let data: Record<string, unknown> = {};
  const createMany = vi.fn(async () => ({ count: 0 }));
  const tx = {
    world: {
      create: vi.fn(async (input: { data: Record<string, unknown> }) => {
        data = input.data;
        return { id: worldId };
      }),
    },
    nation: { createMany, update: vi.fn(async () => ({})) },
    city: { createMany },
    general: { createMany },
    generalTurn: { createMany },
    diplomacy: { createMany },
    nationTurn: { createMany },
  };
  await savePreparedInitialWorld(tx as unknown as Prisma.TransactionClient, prepared);
  return {
    data,
    tx,
    world: {
      preset: null,
      presetKey: null,
      operationalMap: null,
      commandMeta: null,
      ...data,
      id: worldId,
    } as unknown as World,
  };
}
let sourceWorld: World;
beforeAll(async () => {
  const initial = composeInitialWorld(resources, oldSeed);
  initial.ruleFeatures = features;
  sourceWorld = (await capture(prepareInitialWorld(initial, options))).world;
});
function request(world = sourceWorld): Request {
  const intent = worldCreateIntent({
    expectedUserId: userId,
    idempotencyKey: requestId,
    name: world.name,
    scenarioKey: 'integration191',
    mapKey: 'integration',
    statRulesKey: 'five-stats',
    unitSetKey: 'basic',
    portraitMapKey: '191-map',
    ruleFeatures: features,
    seed: oldSeed,
    turnTermMinutes: 30,
    endYear: 200,
  });
  return {
    id: requestId,
    requestedBy: userId,
    idempotencyKey: requestId,
    version: 1,
    intent,
    intentHash: hashState(intent),
    effectiveSeed: oldSeed,
    plannedWorldId: worldId,
    status: 'DONE',
    worldId,
    errorCode: null,
    createdAt: new Date(0),
    processedAt: new Date(1),
    resolution: {
      version: 1,
      selection: {
        scenario: 'integration191',
        map: 'integration',
        unitSet: 'basic',
        statRules: 'five-stats',
        portraitMap: '191-map',
      },
      resources: Object.values(resources).map(({ kind, name, version, contentHash }) => ({
        kind,
        name,
        version,
        contentHash,
      })),
      presetKey: null,
      presetHash: null,
      turnTermMinutes: 30,
      endYear: 200,
      initialStateHash: world.initialStateHash,
    },
  } as unknown as Request;
}
function fixture(useRequest = true) {
  const world = structuredClone(sourceWorld),
    requests = useRequest ? [request(world)] : [],
    rows = structuredClone(Object.values(resources)),
    resets: Event[] = [];
  const tx = {
    world: { findUnique: vi.fn(async () => world) },
    worldCreateRequest: { findMany: vi.fn(async () => requests) },
    gameResource: { findMany: vi.fn(async () => rows) },
    inputEvent: {
      findMany: vi.fn(async (args: Prisma.InputEventFindManyArgs) => {
        expect(args.take).toBe(2);
        return resets;
      }),
    },
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      expect(sql.join('')).toContain('FOR SHARE');
      expect(values).toHaveLength(3);
      return [{ id: 'locked' }];
    }),
    $executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
      expect(sql.join('')).toBe('SET TRANSACTION READ ONLY');
      return 0;
    }),
  };
  const transaction = vi.fn(async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient),
  );
  return {
    world,
    requests,
    rows,
    resets,
    tx,
    transaction,
    db: { $transaction: transaction } as unknown as PrismaClient,
  };
}
async function reject(f: ReturnType<typeof fixture>, code: ResetPreparationError['code']) {
  await expect(prepareWorldReset(f.db, worldId, 'new-seed', controller().signal)).rejects.toMatchObject({ code });
}

async function san10RequestFixture(scenario: 'san10-191' | 'san10-empty') {
  const presetKey = scenario === 'san10-empty' ? 'empty' : 'regular',
    preset = parsePreset(json(`resources/preset/${presetKey}.json`)),
    selected: InitialResources = {
      ...resources,
      map: resource('MAP', 'san10', 'resources/map/san10.json'),
      scenario: resource('SCENARIO', scenario, `resources/scenario/${scenario}.json`),
    },
    san10Features = [
      'campaign-assignment-v2',
      'campaign-v1',
      'city-resources-v1',
      'five-stats',
      'operational-map',
      'personnel',
      'policy',
      'stratagem-basic',
      'treaty',
    ].sort();
  const initial = composeInitialWorld(selected, oldSeed);
  initial.ruleFeatures = san10Features;
  const f = fixture();
  Object.assign(
    f.world,
    (
      await capture(
        prepareInitialWorld(initial, {
          ...options,
          ruleFeatures: san10Features,
          turnTermMinutes: preset.turnTermMinutes,
          preset: { key: presetKey, value: preset },
        }),
      )
    ).world,
  );
  const intent = worldCreateIntent({
    expectedUserId: userId,
    idempotencyKey: requestId,
    name: f.world.name,
    presetKey,
    seed: oldSeed,
    endYear: f.world.endYear,
    ruleFeatures: san10Features,
  });
  f.rows.splice(0, f.rows.length, ...structuredClone(Object.values(selected)));
  f.requests[0] = {
    ...request(f.world),
    intent,
    intentHash: hashState(intent),
    resolution: {
      version: 1,
      selection: { scenario, map: 'san10', unitSet: 'basic', statRules: 'five-stats', portraitMap: '191-map' },
      resources: Object.values(selected).map(({ kind, name, version, contentHash }) => ({
        kind,
        name,
        version,
        contentHash,
      })),
      presetKey,
      presetHash: hashState(preset),
      turnTermMinutes: preset.turnTermMinutes,
      endYear: f.world.endYear,
      initialStateHash: f.world.initialStateHash,
    },
  } as unknown as Request;
  return { f, san10Features };
}

it.each(['san10-191', 'san10-empty'] as const)(
  'AC-INT-18D %s의 생략된 기본 자원도 DONE 출처와152빈원장을 보존해 초기화한다',
  async (scenario) => {
    const { f, san10Features } = await san10RequestFixture(scenario),
      before = structuredClone({ world: f.world, requests: f.requests, rows: f.rows });
    const result = await prepareWorldReset(f.db, worldId, 'new-seed', controller().signal),
      saved = await capture(result.prepared),
      origin = saved.world.replayOrigin as unknown as ReplayOriginV3;
    expect(result.evidence.provenance).toEqual({ kind: 'request', requestId });
    expect(origin.initial.mapKey).toBe('san10');
    expect(origin.initial.scenarioKey).toBe(scenario);
    expect(origin.initial.startYear).toBe(scenario === 'san10-empty' ? 180 : 191);
    expect(origin.initial.nations).toHaveLength(scenario === 'san10-empty' ? 0 : 21);
    expect(origin.initial.generals).toHaveLength(491);
    expect(origin.initial.generals.every((general) => general.userId === null)).toBe(true);
    expect(origin.initial.cities).toHaveLength(152);
    expect(saved.world.ruleFeatures).toEqual(san10Features);
    const ledger = saved.world.cityResourcesState as {
      cities: Record<string, { gold: number; rice: number; garrison: unknown[] }>;
    };
    expect(Object.keys(ledger.cities)).toHaveLength(152);
    expect(
      Object.values(ledger.cities).every((city) => city.gold === 0 && city.rice === 0 && city.garrison.length === 0),
    ).toBe(true);
    expect({ world: f.world, requests: f.requests, rows: f.rows }).toEqual(before);
  },
);

it.each(['san10-191', 'san10-empty'] as const)(
  'AC-M3-04 %s의 생략된 기본 자원을 옛 stat·portrait로 바꾼 DONE 출처는 거부한다',
  async (scenario) => {
    const { f } = await san10RequestFixture(scenario);
    const resolution = f.requests[0]!.resolution as unknown as {
      selection: { statRules: string; portraitMap: string };
    };
    resolution.selection.statRules = 'default';
    resolution.selection.portraitMap = 'rtk14-map';
    await reject(f, 'PROVENANCE_INVALID');
    expect(f.tx.gameResource.findMany).not.toHaveBeenCalled();
  },
);

it('정식21국491명 원본 시드를 완전히 복원하고 새 시드만 결정적으로 준비한다', async () => {
  const f = fixture(),
    before = structuredClone({ world: f.world, requests: f.requests, rows: f.rows });
  const same = await prepareWorldReset(f.db, worldId, oldSeed, controller().signal);
  expect(same.evidence.initialHash).toBe(f.world.initialStateHash);
  const first = await prepareWorldReset(f.db, worldId, 'new-seed', controller().signal);
  const second = await prepareWorldReset(f.db, worldId, 'new-seed', controller().signal);
  expect(first.evidence.initialHash).toBe(second.evidence.initialHash);
  expect(first.evidence.initialHash).not.toBe(f.world.initialStateHash);
  expect(first.evidence.provenance).toEqual({ kind: 'request', requestId });
  expect(first.evidence.resources).toHaveLength(5);
  expect(Object.isFrozen(first.evidence.resources[0])).toBe(true);
  expect(Object.keys(first.prepared)).toEqual(['stateHash']);
  const saved = await capture(first.prepared),
    origin = saved.world.replayOrigin as unknown as ReplayOriginV3;
  expect(origin.initial.nations).toHaveLength(21);
  expect(origin.initial.generals).toHaveLength(491);
  expect(origin.initial.cities).toHaveLength(61);
  expect(origin.initial.generals.every((g) => g.userId === null)).toBe(true);
  expect(origin.initial.seed).toBe('new-seed');
  expect(origin.featureData).toEqual((f.world.replayOrigin as unknown as ReplayOriginV3).featureData);
  expect({ world: f.world, requests: f.requests, rows: f.rows }).toEqual(before);
  expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
    timeout: 30000,
  });
  expect(f.tx.$executeRaw.mock.calls[0]![0]).toEqual(['SET TRANSACTION READ ONLY']);
});
it('CLI 원본도 고정 자원과 정규화 스탯·완전 해시를 대조한다', async () => {
  const f = fixture(false),
    result = await prepareWorldReset(f.db, worldId, oldSeed, controller().signal);
  expect(result.evidence.initialHash).toBe(f.world.initialStateHash);
  expect(result.evidence.provenance).toEqual({ kind: 'cli' });
});
it('저장 프리셋과 원본 featureData를 쓰며 현재 파일의 이름·설정을 다시 읽지 않는다', async () => {
  const f = fixture(false),
    preset = parsePreset(json('resources/preset/regular.json'));
  preset.name = '저장된 독립 프리셋';
  preset.turnTermMinutes = 37;
  const initial = composeInitialWorld(resources, oldSeed);
  initial.ruleFeatures = features;
  Object.assign(
    f.world,
    (
      await capture(
        prepareInitialWorld(initial, {
          ...options,
          turnTermMinutes: 37,
          preset: { key: 'stored-custom', value: preset },
        }),
      )
    ).world,
  );
  const result = await prepareWorldReset(f.db, worldId, 'new-seed', controller().signal),
    saved = await capture(result.prepared);
  expect(saved.world.preset).toEqual(preset);
  expect(saved.world.presetKey).toBe('stored-custom');
  expect(saved.world.turnTermMinutes).toBe(37);
});
it.each([1, 2, 4])('구형/미지원 형식%d는 자원 조회 전에 거부한다', async (replayFormat) => {
  const f = fixture();
  f.world.replayFormat = replayFormat;
  await reject(f, 'UNSUPPORTED_FORMAT');
  expect(f.tx.gameResource.findMany).not.toHaveBeenCalled();
});
it.each([
  'seed',
  'mapKey',
  'scenarioKey',
  'unitSetKey',
  'initialStateHash',
  'startYear',
  'statRules',
  'unitSet',
  'operationalMap',
  'commandMeta',
] as const)('World 불변 mirror %s 변조를 거부한다', async (field) => {
  const f = fixture();
  Object.assign(f.world, {
    [field]:
      field === 'startYear'
        ? 999
        : field === 'statRules' || field === 'unitSet' || field === 'operationalMap' || field === 'commandMeta'
          ? {}
          : 'tamper',
  });
  await reject(f, 'ORIGIN_INVALID');
});
it('동시에 재해시한 사람 소유 원본도 복사하지 않는다', async () => {
  const f = fixture(),
    origin = f.world.replayOrigin as unknown as ReplayOriginV3;
  origin.initial.generals[0]!.userId = userId;
  origin.initialStateHash = hashState(origin.initial);
  f.world.initialStateHash = origin.initialStateHash;
  await reject(f, 'ORIGIN_INVALID');
});
it('원본 초기 상태 자체의 변경과 기능·프리셋 불일치를 거부한다', async () => {
  const a = fixture();
  (a.world.replayOrigin as unknown as ReplayOriginV3).initial.cities[0]!.population++;
  await reject(a, 'ORIGIN_INVALID');
  const b = fixture();
  b.world.ruleFeatures.push('unknown');
  await reject(b, 'ORIGIN_INVALID');
  const c = fixture();
  c.world.presetKey = 'absent';
  await reject(c, 'ORIGIN_INVALID');
});
it('원본 자원 해시와 featureData 정책 간격을 별도로 검증한다', async () => {
  const a = fixture();
  (a.world.replayOrigin as unknown as ReplayOriginV3).resourceHash = '0'.repeat(64);
  await reject(a, 'ORIGIN_INVALID');
  const b = fixture();
  (b.world.replayOrigin as unknown as ReplayOriginV3).featureData = { policy: { version: 1, turnTermMinutes: 999 } };
  await reject(b, 'ORIGIN_INVALID');
});
it.each([
  'status',
  'plannedWorldId',
  'worldId',
  'version',
  'intentHash',
  'effectiveSeed',
  'resolution',
  'processedAt',
] as const)('존재하는 생성 요청의 %s 오류는 CLI fallback하지 않는다', async (field) => {
  const f = fixture(),
    r = f.requests[0]!;
  Object.assign(r, {
    [field]: field === 'version' ? 2 : field === 'resolution' ? {} : field === 'processedAt' ? null : 'wrong',
  });
  await reject(f, 'PROVENANCE_INVALID');
  expect(f.tx.gameResource.findMany).not.toHaveBeenCalled();
});
it('같은 원본을 가리키는 중복 요청과 manifest 누락·중복 종류를 거부한다', async () => {
  const f = fixture();
  f.requests.push(structuredClone(f.requests[0]!));
  await reject(f, 'PROVENANCE_INVALID');
  const g = fixture();
  const resolution = g.requests[0]!.resolution as unknown as { resources: unknown[] };
  resolution.resources[1] = resolution.resources[0];
  await reject(g, 'PROVENANCE_INVALID');
});
it('생성 manifest의 자원 선택·고정 해시·프리셋·간격·연도 전체 연관을 확인한다', async () => {
  for (const field of ['selection', 'presetHash', 'turnTermMinutes', 'endYear', 'initialStateHash']) {
    const f = fixture(),
      resolution = f.requests[0]!.resolution as Record<string, unknown>;
    resolution[field] =
      field === 'selection'
        ? { scenario: 'other', map: 'integration', unitSet: 'basic', statRules: 'five-stats', portraitMap: '191-map' }
        : field === 'turnTermMinutes' || field === 'endYear'
          ? 999
          : '0'.repeat(64);
    await reject(f, 'PROVENANCE_INVALID');
    expect(f.tx.gameResource.findMany).not.toHaveBeenCalled();
  }
  const pinned = fixture(),
    resolution = pinned.requests[0]!.resolution as unknown as { resources: { contentHash: string }[] };
  resolution.resources[0]!.contentHash = '0'.repeat(64);
  await reject(pinned, 'RESOURCE_INVALID');
});
it('원본 intent 기능을 바꾸고 재해시해도 원생성 기능과 다르면 거부한다', async () => {
  const f = fixture(),
    r = f.requests[0]!,
    intent = r.intent as unknown as { ruleFeatures: string[] };
  intent.ruleFeatures = ['five-stats', 'operational-map'];
  r.intentHash = hashState(intent);
  await reject(f, 'PROVENANCE_INVALID');
});
it('pin과 다른 내용 해시·미게시 누락·동일 tuple 중복 자원을 거부한다', async () => {
  const a = fixture();
  a.rows[0]!.contentHash = '0'.repeat(64);
  await reject(a, 'RESOURCE_INVALID');
  const b = fixture();
  b.rows.splice(0, 1);
  await reject(b, 'RESOURCE_INVALID');
  const c = fixture();
  c.rows.push(structuredClone(c.rows[0]!));
  await reject(c, 'RESOURCE_INVALID');
});
it('내용과 pin을 함께 재해시해도 원 시드의 완전 초기 해시가 다르면 거부한다', async () => {
  const f = fixture(false),
    portrait = f.rows.find((r) => r.kind === 'PORTRAIT_MAP')!;
  const content = portrait.content as { portraits: Record<string, number> };
  const name = Object.keys(content.portraits)[0]!;
  content.portraits[name] = 10001;
  portrait.contentHash = hashState(content);
  await reject(f, 'RESOURCE_INVALID');
});
it('동일 내용 후보는 해시로 묶고 다른 내용의 모호한 원본 후보는 거부한다', async () => {
  const equivalent = fixture(false),
    copy = structuredClone(equivalent.rows.find((r) => r.kind === 'PORTRAIT_MAP')!);
  copy.name = 'same-content';
  equivalent.rows.push(copy);
  const ok = await prepareWorldReset(equivalent.db, worldId, oldSeed, controller().signal);
  expect(ok.evidence.initialHash).toBe(equivalent.world.initialStateHash);
  const ambiguous = fixture(false),
    extra = structuredClone(ambiguous.rows.find((r) => r.kind === 'PORTRAIT_MAP')!);
  extra.name = 'different-content';
  (extra.content as { portraits: Record<string, number> }).portraits['unused-test-officer'] = 10001;
  extra.contentHash = hashState(extra.content);
  ambiguous.rows.push(extra);
  await reject(ambiguous, 'RESOURCE_AMBIGUOUS');
});
it('원본 스탯이 일치하지 않으면 다른 후보·평균 값으로 채우지 않는다', async () => {
  const f = fixture(false);

  f.tx.gameResource.findMany.mockResolvedValueOnce(f.rows.filter((r) => r.kind !== 'STAT_RULES'));
  await reject(f, 'RESOURCE_INVALID');
});
it('DB 오류는 원문 객체 그대로 전파하고 CLI fallback으로 바꾸지 않는다', async () => {
  const f = fixture(),
    error = new Error('private transport sentinel');
  f.tx.worldCreateRequest.findMany.mockRejectedValueOnce(error);
  await expect(prepareWorldReset(f.db, worldId, 'new-seed', controller().signal)).rejects.toBe(error);
  expect(f.tx.gameResource.findMany).not.toHaveBeenCalled();
  const g = fixture(false);
  g.tx.gameResource.findMany.mockRejectedValueOnce(error);
  await expect(prepareWorldReset(g.db, worldId, 'new-seed', controller().signal)).rejects.toBe(error);
});
it('없어진 원본은 자원 조회 없이 고정 사유로 거부한다', async () => {
  const f = fixture();
  f.tx.world.findUnique.mockResolvedValueOnce(null as unknown as World);
  await reject(f, 'WORLD_NOT_FOUND');
  expect(f.tx.worldCreateRequest.findMany).not.toHaveBeenCalled();
});
it('중단된 요청은 다음 SQL이나 준비를 시작하지 않는다', async () => {
  const f = fixture(),
    c = controller();
  c.abort();
  await expect(prepareWorldReset(f.db, worldId, 'new-seed', c.signal)).rejects.toThrow();
  expect(f.transaction).not.toHaveBeenCalled();
  const g = fixture(),
    late = controller();
  g.tx.world.findUnique.mockImplementationOnce(async () => {
    late.abort();
    return g.world;
  });
  await expect(prepareWorldReset(g.db, worldId, 'new-seed', late.signal)).rejects.toThrow();
  expect(g.tx.worldCreateRequest.findMany).not.toHaveBeenCalled();
});
it.each(['', '\u0000', '\ud800'])('저장 불가능한 새 시드%j는 SQL 전에 고정 오류로 거부한다', async (value) => {
  const f = fixture();
  await expect(prepareWorldReset(f.db, worldId, value, controller().signal)).rejects.toMatchObject({
    code: 'INPUT_INVALID',
  });
  expect(f.transaction).not.toHaveBeenCalled();
});

function resetEvent(world = sourceWorld): Event {
  const oldWorldId = '00000000-0000-4000-8000-000000000004',
    origin = world.replayOrigin as unknown as ReplayOriginV3;
  return {
    id: 11n,
    worldId: oldWorldId,
    userId,
    idempotencyKey: requestId,
    generalId: null,
    kind: ADMIN_RESET_KIND,
    status: 'APPLIED',
    sequence: 1,
    tick: 0,
    stepTick: null,
    createdAt: new Date(0),
    payload: {
      version: 1,
      sourceWorldId: oldWorldId,
      plannedNewWorldId: worldId,
      effectiveSeed: world.seed,
      intent: { confirmName: world.name, expectedRevision: 2, reason: '초기화', requestedSeed: world.seed },
    },
    result: {
      version: 1,
      sourceWorldId: oldWorldId,
      newWorldId: worldId,
      effectiveSeed: world.seed,
      before: { status: 'PAUSED', tick: 0, revision: 2 },
      after: { status: 'ENDED', tick: 0, revision: 3 },
      at: new Date(1).toISOString(),
      finalStateHash: 'a'.repeat(64),
      sourceInitialHash: 'b'.repeat(64),
      sourceResourceHash: origin.resourceHash,
      sourceSettingsHash: 'c'.repeat(64),
      newInitialHash: world.initialStateHash,
      newResourceHash: origin.resourceHash,
      newSettingsHash: resetSourceSettingsHash(world),
      resources: Object.values(resources)
        .map(({ kind, name, version, contentHash }) => ({ kind, name, version, contentHash }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
      settings: resetSettingsReference(world),
    },
  } as unknown as Event;
}
const transactionClient = (f: ReturnType<typeof fixture>) => f.tx as unknown as Prisma.TransactionClient;
it('D1 공유 settings hash 추출은 승인된 C 원 recipe와 같다', () => {
  const w = sourceWorld;
  expect(resetSourceSettingsHash(w)).toBe(
    hashState({
      name: w.name,
      seed: w.seed,
      scenario: w.scenarioKey,
      map: w.mapKey,
      unitSet: w.unitSetKey,
      presetKey: w.presetKey,
      preset: w.preset,
      turnTermMinutes: w.turnTermMinutes,
      endYear: w.endYear,
      ruleFeatures: w.ruleFeatures,
      origin: w.replayOrigin,
    }),
  );
});
it('D1 APPLIED reset 원장을 출처로 새 월드를 다시 준비한다', async () => {
  const f = fixture(false);
  f.resets.push(resetEvent(f.world));
  const prepared = await prepareWorldReset(f.db, worldId, oldSeed, controller().signal);
  expect(prepared.evidence.provenance).toEqual({ kind: 'reset', requestId: '11' });
  expect(prepared.evidence.initialHash).toBe(f.world.initialStateHash);
  await verifyResetPreparation(transactionClient(f), f.world, prepared, oldSeed, controller().signal);
  expect(f.tx.inputEvent.findMany.mock.calls[0]![0]).toMatchObject({ take: 2, where: { kind: ADMIN_RESET_KIND } });
});
it.each(['PENDING', 'REJECTED'] as const)('D1 존재하는 reset %s는 CLI fallback하지 않는다', async (status) => {
  const f = fixture(false),
    event = resetEvent(f.world);
  event.status = status;
  f.resets.push(event);
  await reject(f, 'PROVENANCE_INVALID');
  expect(f.tx.gameResource.findMany).not.toHaveBeenCalled();
});
it('D1 B와 reset 또는 reset 두 개가 같은 target을 가리키면 거부한다', async () => {
  const a = fixture();
  a.resets.push(resetEvent(a.world));
  await reject(a, 'PROVENANCE_INVALID');
  const b = fixture(false);
  b.resets.push(resetEvent(b.world), resetEvent(b.world));
  await reject(b, 'PROVENANCE_INVALID');
});
it('D1 reset target·초기hash·settings·resourcehash·manifest 변조를 거부한다', async () => {
  for (const delta of [
    { newWorldId: userId },
    { newInitialHash: 'a'.repeat(64) },
    { newSettingsHash: 'a'.repeat(64) },
    { newResourceHash: 'a'.repeat(64) },
    { settings: { ...resetSettingsReference(sourceWorld), turnTermMinutes: 99 } },
    { resources: [] },
  ]) {
    const f = fixture(false),
      event = resetEvent(f.world);
    event.result = { ...(event.result as Prisma.JsonObject), ...delta } as Prisma.JsonValue;
    f.resets.push(event);
    await reject(f, 'PROVENANCE_INVALID');
    expect(f.tx.gameResource.findMany).not.toHaveBeenCalled();
  }
});
it('D1 같은 적용 TX의 verifier는 자원5종을 정렬 FOR SHARE한 뒤 pin을 다시 읽는다', async () => {
  const f = fixture(),
    prepared = await prepareWorldReset(f.db, worldId, 'new', controller().signal);
  await verifyResetPreparation(transactionClient(f), f.world, prepared, 'new', controller().signal);
  expect(f.transaction).toHaveBeenCalledOnce();
  expect(f.tx.$queryRaw.mock.calls.map((call) => call.slice(1))).toEqual(
    prepared.evidence.resources.map((ref) => [ref.kind, ref.name, ref.version]),
  );
  expect(f.tx.gameResource.findMany).toHaveBeenCalledTimes(2);
});
it('D1 준비 뒤 B 요청의 행위자·processedAt 변경을 같은 TX fingerprint가 거부한다', async () => {
  for (const field of ['requestedBy', 'processedAt']) {
    const f = fixture(),
      prepared = await prepareWorldReset(f.db, worldId, 'new', controller().signal);
    Object.assign(f.requests[0]!, { [field]: field === 'processedAt' ? new Date(9) : requestId });
    await expect(
      verifyResetPreparation(transactionClient(f), f.world, prepared, 'new', controller().signal),
    ).rejects.toMatchObject({ code: 'PROVENANCE_INVALID' });
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  }
});
it('D1 준비 뒤 원본 설정·고정자원 변경을 적용 전에 거부한다', async () => {
  const f = fixture(),
    prepared = await prepareWorldReset(f.db, worldId, 'new', controller().signal);
  f.world.name = 'changed';
  await expect(
    verifyResetPreparation(transactionClient(f), f.world, prepared, 'new', controller().signal),
  ).rejects.toMatchObject({ code: 'PROVENANCE_INVALID' });
  const g = fixture(false),
    pin = await prepareWorldReset(g.db, worldId, 'new', controller().signal);
  g.rows[0]!.contentHash = 'a'.repeat(64);
  await expect(
    verifyResetPreparation(transactionClient(g), g.world, pin, 'new', controller().signal),
  ).rejects.toMatchObject({ code: 'RESOURCE_INVALID' });
});
it('D1 존재하던 provenance가 없어지거나 새 reset이 생겨도 후보를 폐기한다', async () => {
  const f = fixture(),
    candidate = await prepareWorldReset(f.db, worldId, 'new', controller().signal);
  f.requests.length = 0;
  await expect(
    verifyResetPreparation(transactionClient(f), f.world, candidate, 'new', controller().signal),
  ).rejects.toMatchObject({ code: 'PROVENANCE_INVALID' });
  const g = fixture(false),
    cli = await prepareWorldReset(g.db, worldId, 'new', controller().signal);
  g.resets.push(resetEvent(g.world));
  await expect(
    verifyResetPreparation(transactionClient(g), g.world, cli, 'new', controller().signal),
  ).rejects.toMatchObject({ code: 'PROVENANCE_INVALID' });
});
it('D1 reset provenance 조회의 DB 실패는 원문 객체를 전파하고 fallback하지 않는다', async () => {
  const f = fixture(false),
    error = new Error('transport');
  f.tx.inputEvent.findMany.mockRejectedValueOnce(error);
  await expect(prepareWorldReset(f.db, worldId, 'new', controller().signal)).rejects.toBe(error);
  expect(f.tx.gameResource.findMany).not.toHaveBeenCalled();
});
it('D1 verifier 잠금 중 취소 뒤 다음 SQL과 자원 읽기는0이다', async () => {
  const f = fixture(),
    candidate = await prepareWorldReset(f.db, worldId, 'new', controller().signal),
    c = controller();
  f.tx.$queryRaw.mockImplementationOnce(async () => {
    c.abort();
    return [{ id: 'locked' }];
  });
  await expect(verifyResetPreparation(transactionClient(f), f.world, candidate, 'new', c.signal)).rejects.toThrow();
  expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
  expect(f.tx.gameResource.findMany).toHaveBeenCalledOnce();
});
it.each(['initialHash', 'effectiveSeed'] as const)('D1 %s만 치환한 증거는 SQL 전에 거부한다', async (field) => {
  const f = fixture(),
    candidate = await prepareWorldReset(f.db, worldId, 'new', controller().signal),
    changed = {
      ...candidate,
      evidence: { ...candidate.evidence, [field]: field === 'initialHash' ? 'a'.repeat(64) : 'other' },
    };
  await expect(
    verifyResetPreparation(transactionClient(f), f.world, changed, 'new', controller().signal),
  ).rejects.toMatchObject({ code: 'PROVENANCE_INVALID' });
  expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  expect(f.tx.gameResource.findMany).toHaveBeenCalledOnce();
});
it('D1 다른 시드 후보와 증거를 교차하거나 구조만 복사한 후보는 거부한다', async () => {
  const f = fixture(),
    first = await prepareWorldReset(f.db, worldId, 'first', controller().signal),
    second = await prepareWorldReset(f.db, worldId, 'second', controller().signal);
  for (const candidate of [
    { prepared: first.prepared, evidence: second.evidence },
    { prepared: second.prepared, evidence: first.evidence },
    { ...first },
    structuredClone(first),
    { prepared: { stateHash: first.evidence.initialHash }, evidence: first.evidence },
  ] satisfies ResetPreparation[])
    await expect(
      verifyResetPreparation(transactionClient(f), f.world, candidate, 'first', controller().signal),
    ).rejects.toMatchObject({ code: 'PROVENANCE_INVALID' });
  expect(f.tx.$queryRaw).not.toHaveBeenCalled();
});
it('D1 신뢰된 준비물도 원 요청의 effectiveSeed와 다르면 거부한다', async () => {
  const f = fixture(),
    candidate = await prepareWorldReset(f.db, worldId, 'actual', controller().signal);
  await expect(
    verifyResetPreparation(transactionClient(f), f.world, candidate, 'other-request', controller().signal),
  ).rejects.toMatchObject({ code: 'PROVENANCE_INVALID' });
  expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  await verifyResetPreparation(transactionClient(f), f.world, candidate, 'actual', controller().signal);
  expect(f.tx.$queryRaw).toHaveBeenCalledTimes(5);
});
