import { readFileSync } from 'node:fs';
import type { Prisma, PrismaClient, PublishedResource } from '@opensamguk/db';
import { parsePreset, worldCreateIntent, type ReplayOriginV3 } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { beforeAll, expect, it, vi } from 'vitest';
import { composeInitialWorld, type InitialResources } from '../world/resources';
import {
  prepareInitialWorld,
  savePreparedInitialWorld,
  type InitialWorldOptions,
  type PreparedInitialWorld,
} from '../world/persistence';
import { prepareWorldReset, ResetPreparationError } from './resetPreparation';

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
    rows = structuredClone(Object.values(resources));
  const tx = {
    world: { findUnique: vi.fn(async () => world) },
    worldCreateRequest: { findMany: vi.fn(async () => requests) },
    gameResource: { findMany: vi.fn(async () => rows) },
    $executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
      expect(sql.join('')).toBe('SET TRANSACTION READ ONLY');
      return 0;
    }),
  };
  const transaction = vi.fn(async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient),
  );
  return { world, requests, rows, tx, transaction, db: { $transaction: transaction } as unknown as PrismaClient };
}
async function reject(f: ReturnType<typeof fixture>, code: ResetPreparationError['code']) {
  await expect(prepareWorldReset(f.db, worldId, 'new-seed', controller().signal)).rejects.toMatchObject({ code });
}
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
