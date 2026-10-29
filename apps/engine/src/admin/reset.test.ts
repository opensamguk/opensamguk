import { beforeEach, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { initialReplayStateWithRegistry, ruleRegistry, ADMIN_RESET_KIND } from '@opensamguk/rules';
import type { Lease } from '../lease';
import { renewLease } from '../lease';
import { monthlyFixture } from '../../test/monthlyFixture';
import { resourceHashV3 } from '../replay';
import { savePreparedInitialWorld } from '../world/persistence';
import * as preparation from './resetPreparation';
import { preparePendingReset, processAdminReset, checkedResetTarget } from './reset';
import { loadReplayState } from '../monthly';

vi.mock('../lease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lease')>()),
  renewLease: vi.fn().mockResolvedValue(undefined),
  databaseNow: vi.fn().mockResolvedValue(new Date('2026-10-29T00:00:00Z')),
}));
vi.mock('../monthly', () => ({ loadReplayState: vi.fn() }));
vi.mock('../world/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../world/persistence')>()),
  savePreparedInitialWorld: vi.fn(),
}));
vi.mock('./resetPreparation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resetPreparation')>()),
  prepareWorldReset: vi.fn(),
  verifyResetPreparation: vi.fn().mockResolvedValue(undefined),
}));
beforeEach(() => vi.clearAllMocks());
type World = Prisma.WorldGetPayload<Record<string, never>>;
type Event = Prisma.InputEventGetPayload<Record<string, never>>;
const worldId = '00000000-0000-4000-8000-000000000001',
  targetId = '00000000-0000-4000-8000-000000000002',
  userId = '00000000-0000-4000-8000-000000000003';
const lease = { worldId, ownerId: 'own-lease', fencingToken: 1, ttlMs: 15000 } satisfies Lease;
async function fixture() {
  const initial = await monthlyFixture(),
    origin = { version: 3 as const, initial, initialStateHash: hashState(initial), resourceHash: '' };
  origin.resourceHash = resourceHashV3(origin);
  const world = {
    id: worldId,
    name: '초기화 원본',
    status: 'PAUSED',
    seed: initial.seed,
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    preset: null,
    presetKey: null,
    turnTermMinutes: 30,
    endYear: null,
    ruleFeatures: [],
    replayFormat: 3,
    replayOrigin: origin,
    initialStateHash: origin.initialStateHash,
    clockTick: 0,
    clockRevision: 2,
    actionSequence: 2,
    startedAt: new Date(0),
    endedAt: null,
  } as unknown as World;
  const nextInitial = { ...structuredClone(initial), seed: 'new-seed' },
    nextOrigin = { ...origin, initial: nextInitial, initialStateHash: hashState(nextInitial) };
  const target = {
    ...structuredClone(world),
    id: targetId,
    seed: 'new-seed',
    status: 'PREOPEN',
    replayOrigin: nextOrigin,
    initialStateHash: nextOrigin.initialStateHash,
    clockRevision: 0,
    actionSequence: 0,
    startedAt: null,
    endedAt: null,
  } as unknown as World;
  const event = {
    id: 11n,
    worldId,
    userId,
    idempotencyKey: userId,
    generalId: null,
    sequence: null,
    tick: null,
    stepTick: null,
    status: 'PENDING',
    kind: ADMIN_RESET_KIND,
    result: null,
    payload: {
      version: 1,
      sourceWorldId: worldId,
      plannedNewWorldId: targetId,
      effectiveSeed: 'new-seed',
      intent: { confirmName: world.name, expectedRevision: 2, reason: '초기화 확인', requestedSeed: 'new-seed' },
    },
  } as unknown as Event;
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
    version: 1 as const,
    contentHash: 'a'.repeat(64),
  }));
  const candidate = {
    prepared: Object.freeze({ stateHash: target.initialStateHash! }),
    evidence: {
      version: 1 as const,
      sourceWorldId: worldId,
      sourceSeed: world.seed,
      effectiveSeed: 'new-seed',
      sourceInitialHash: world.initialStateHash!,
      initialHash: target.initialStateHash!,
      sourceResourceHash: origin.resourceHash,
      sourceSettingsHash: preparation.resetSourceSettingsHash(world),
      provenance: { kind: 'cli' as const },
      provenanceFingerprint: 'b'.repeat(64),
      resources,
    },
  };
  vi.mocked(preparation.prepareWorldReset).mockResolvedValue(candidate);
  vi.mocked(loadReplayState).mockResolvedValue(initialReplayStateWithRegistry(initial, ruleRegistry));
  const actor = { status: 'ACTIVE', role: 'ADMIN' },
    audits: unknown[] = [],
    forbidden = vi.fn(() => {
      throw Error('원본 게임 쓰기 금지');
    });
  let collision = false;
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: userId }]),
    user: { findUnique: vi.fn(async () => actor) },
    sanction: { findFirst: vi.fn(async () => null as { id: string } | null) },
    worldResult: { findUnique: vi.fn(async () => null as { worldId: string } | null), create: forbidden },
    world: {
      findUnique: vi.fn(async () => (collision ? target : null)),
      findUniqueOrThrow: vi.fn(async () => target),
      updateMany: vi.fn(async ({ data }: { data: Partial<World> }) => {
        world.status = data.status!;
        world.endedAt = data.endedAt!;
        world.clockRevision++;
        return { count: 1 };
      }),
      update: vi.fn(async () => ({ actionSequence: ++world.actionSequence })),
      delete: forbidden,
    },
    inputEvent: {
      updateMany: vi.fn(async ({ data }: { data: Partial<Event> }) => {
        Object.assign(event, data);
        return { count: 1 };
      }),
    },
    auditLog: {
      create: vi.fn(async (value: unknown) => {
        audits.push(value);
        return {};
      }),
    },
    general: { updateMany: forbidden, deleteMany: forbidden },
    generalTurn: { createMany: forbidden, deleteMany: forbidden },
  };
  vi.mocked(savePreparedInitialWorld).mockResolvedValue({ worldId: targetId, stateHash: target.initialStateHash! });
  const db = {} as PrismaClient,
    client = tx as unknown as Prisma.TransactionClient;
  return {
    world,
    target,
    event,
    candidate,
    actor,
    audits,
    forbidden,
    tx,
    db,
    client,
    setCollision: () => {
      collision = true;
    },
    prepare: () => preparePendingReset(db, lease, event),
    apply: (value?: Awaited<ReturnType<typeof preparePendingReset>>, signal?: AbortSignal) =>
      processAdminReset(client, world, event, value, signal),
  };
}
it('D2 대역: 첫 fenced probe는 정확 reset event만 돌려주며 쓰기0이다', async () => {
  const f = await fixture(),
    before = structuredClone(f.world);
  expect(await f.apply()).toMatchObject({ deferred: true, resetEvent: f.event, status: 'PAUSED' });
  expect(f.world).toEqual(before);
  expect(f.tx.world.update).not.toHaveBeenCalled();
  expect(f.audits).toHaveLength(0);
});
it('D2 대역: 원 후보·요청 seed로 검증하고 target저장→source종료→입력·감사를 같은 client에 쓴다', async () => {
  const f = await fixture(),
    prepared = await f.prepare();
  expect(await f.apply(prepared)).toEqual({ status: 'ENDED', tick: 0 });
  expect(preparation.verifyResetPreparation).toHaveBeenCalledWith(
    f.client,
    expect.anything(),
    f.candidate,
    'new-seed',
    expect.any(AbortSignal),
  );
  expect(savePreparedInitialWorld).toHaveBeenCalledExactlyOnceWith(f.client, f.candidate.prepared, targetId);
  expect(f.event).toMatchObject({
    status: 'APPLIED',
    sequence: 3,
    tick: 0,
    result: {
      sourceWorldId: worldId,
      newWorldId: targetId,
      newSettingsHash: preparation.resetSourceSettingsHash(f.target),
    },
  });
  expect(f.tx.worldResult.create).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(() => checkedResetTarget(f.world, f.event, f.target)).not.toThrow();
});
it('D2 대역: 준비 뒤 다른 선두·payload·wrapper를 가져오면 적용하지 않는다', async () => {
  for (const mode of ['event', 'payload', 'wrapper']) {
    const f = await fixture(),
      prepared = await f.prepare();
    if (mode === 'event') f.event.id = 12n;
    if (mode === 'payload')
      ((f.event.payload as Record<string, unknown>).intent as Record<string, unknown>).reason = '바뀐 사유';
    expect(await f.apply(mode === 'wrapper' ? { ...prepared } : prepared)).toMatchObject({ deferred: true });
    expect(savePreparedInitialWorld).not.toHaveBeenCalled();
    vi.mocked(savePreparedInitialWorld).mockClear();
  }
});
it.each(['inactive', 'role', 'sanction', 'state', 'name', 'revision', 'result', 'target'] as const)(
  'D2 대역: 현재 %s 변화는 새World0으로 고정 기각한다',
  async (mode) => {
    const f = await fixture(),
      prepared = await f.prepare();
    if (mode === 'inactive') f.actor.status = 'WITHDRAWN';
    if (mode === 'role') f.actor.role = 'USER';
    if (mode === 'sanction') f.tx.sanction.findFirst.mockResolvedValueOnce({ id: 'sanction' });
    if (mode === 'state') f.world.status = 'RUNNING';
    if (mode === 'name') f.world.name = 'changed';
    if (mode === 'revision') f.world.clockRevision++;
    if (mode === 'result') f.tx.worldResult.findUnique.mockResolvedValueOnce({ worldId });
    if (mode === 'target') f.setCollision();
    await f.apply(prepared);
    expect(f.event.status).toBe('REJECTED');
    expect(savePreparedInitialWorld).not.toHaveBeenCalled();
    expect(f.tx.world.updateMany).not.toHaveBeenCalled();
    expect(f.audits).toHaveLength(1);
  },
);
it('D2 대역: C의 확정 자료 오류만 기각하고 접속 오류는 그대로 전파한다', async () => {
  const f = await fixture();
  vi.mocked(preparation.prepareWorldReset).mockRejectedValueOnce(
    new preparation.ResetPreparationError('RESOURCE_INVALID'),
  );
  await f.apply(await f.prepare());
  expect(f.event).toMatchObject({ status: 'REJECTED', result: { code: 'RESOURCE_INVALID' } });
  const g = await fixture(),
    error = new Error('transport');
  vi.mocked(preparation.prepareWorldReset).mockRejectedValueOnce(error);
  await expect(g.prepare()).rejects.toBe(error);
  expect(g.event.status).toBe('PENDING');
});
it('D2 대역: 적용 TX 재검증 자료 오류는 고정 기각, DB 오류는 전파한다', async () => {
  const f = await fixture(),
    prepared = await f.prepare();
  vi.mocked(preparation.verifyResetPreparation).mockRejectedValueOnce(
    new preparation.ResetPreparationError('PROVENANCE_INVALID'),
  );
  await f.apply(prepared);
  expect(f.event).toMatchObject({ status: 'REJECTED', result: { code: 'RESOURCE_INVALID' } });
  const g = await fixture(),
    pin = await g.prepare(),
    error = new Error('DB');
  vi.mocked(preparation.verifyResetPreparation).mockRejectedValueOnce(error);
  await expect(g.apply(pin)).rejects.toBe(error);
  expect(g.event.status).toBe('PENDING');
  expect(savePreparedInitialWorld).not.toHaveBeenCalled();
});
it('D2 대역: 취소·리스 갱신 실패 뒤 후보/게임 쓰기를 시작하지 않는다', async () => {
  const f = await fixture(),
    c = new AbortController();
  c.abort();
  await expect(preparePendingReset(f.db, lease, f.event, c.signal)).rejects.toThrow();
  expect(renewLease).not.toHaveBeenCalled();
  const error = new Error('lease lost');
  vi.mocked(renewLease).mockRejectedValueOnce(error);
  await expect(f.prepare()).rejects.toBe(error);
  expect(preparation.prepareWorldReset).not.toHaveBeenCalled();
  expect(savePreparedInitialWorld).not.toHaveBeenCalled();
});
it('D3 대역: 연결된 target의 seed·초기hash·설정을 바꾸면 source 성공으로 추측하지 않는다', async () => {
  const f = await fixture();
  await f.apply(await f.prepare());
  for (const delta of [
    { id: worldId },
    { seed: 'other' },
    { initialStateHash: 'a'.repeat(64) },
    { turnTermMinutes: 99 },
  ])
    expect(() => checkedResetTarget(f.world, f.event, { ...f.target, ...delta })).toThrow();
});
it('D2 대역: 저장 순번 상한은 후보·상태 쓰기 전에 거부한다', async () => {
  const f = await fixture();
  f.world.actionSequence = 2_147_483_647;
  await expect(f.apply()).rejects.toThrow('순번');
  expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  expect(savePreparedInitialWorld).not.toHaveBeenCalled();
});
it('D2 대역: 준비 도중 리스 갱신 실패는 대기 작업을 취소하고 모두 정착한다', async () => {
  const f = await fixture(),
    failure = new Error('renewal lost');
  vi.mocked(renewLease).mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
  vi.mocked(preparation.prepareWorldReset).mockImplementationOnce(
    async (_db, _id, _seed, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      }),
  );
  // 대역 리스만1ms 간격으로 갱신한다. 실제15초 리스/PG 시험 기한은 바꾸지 않는다.
  await expect(preparePendingReset(f.db, { ...lease, ttlMs: 3 }, f.event)).rejects.toBe(failure);
  expect(renewLease).toHaveBeenCalledTimes(2);
  expect(savePreparedInitialWorld).not.toHaveBeenCalled();
});
