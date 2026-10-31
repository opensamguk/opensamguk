import { beforeEach, expect, it, vi } from 'vitest';
import type { Context } from '../context';
import { buildInitialWorld, toWorldState, unitSetSchema, emptyCampaignState } from '@opensamguk/rules';
import { readFileSync } from 'node:fs';
import { readView, requireGeneral, requireWorld } from './queries';
import { submitCampaignOrder, readCampaignOrders } from './campaignOrders';

vi.mock('../messaging', () => ({ databaseTime: vi.fn(async () => new Date('2026-10-30T00:00:00Z')) }));
vi.mock('./queries', async (original) => ({
  ...(await original<typeof import('./queries')>()),
  requireWorld: vi.fn(),
  requireGeneral: vi.fn(),
  readView: vi.fn(),
}));
vi.mock('@opensamguk/rules', async (original) => ({
  ...(await original<typeof import('@opensamguk/rules')>()),
  checkReplayOrigin: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
const resource = (path: string) =>
  JSON.parse(readFileSync(new URL('../../../../resources/' + path + '.json', import.meta.url), 'utf8'));
const testUnits = unitSetSchema.parse(resource('unitset/basic'));
function fixture() {
  const view = toWorldState(
    buildInitialWorld({
      map: resource('map/integration'),
      scenario: resource('scenario/integration191'),
      statRules: resource('scenario/five-stats'),
      unitSet: testUnits,
      seed: 'order-api-boundary',
    }),
  );
  view.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'];
  for (const general of Object.values(view.generals))
    Object.assign(general, { crew: 0, politics: 60, charm: 55, cityKey: 1, nationId: 1 });
  view.generals[1]!.userId = 'owner';
  view.generals[3]!.userId = 'recipient';
  view.campaign = emptyCampaignState(view, 'order-source', 'test-source');
  view.campaign.links = [{ masterId: 1, personId: 3, relation: 'STAFF' }];
  const world = {
    id: 'world',
    status: 'RUNNING',
    replayFormat: 3,
    replayOrigin: { version: 3, initial: { ruleFeatures: view.ruleFeatures, unitSet: testUnits } },
    ruleFeatures: view.ruleFeatures,
    unitSet: testUnits,
    preset: null,
    clockTick: 0,
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
    session: {
      findFirst: vi.fn(async (): Promise<unknown> => ({
        user: { status: 'ACTIVE', emailVerifiedAt: new Date(), consents: [] },
      })),
    },
    sanction: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    general: { findUnique: vi.fn(async () => ({ id: 3, turnRevision: 0 })) },
    world: { findUniqueOrThrow: vi.fn(async () => world) },
    generalTurn: {
      findMany: vi.fn(async () =>
        Array.from({ length: 30 }, (_, slot) => ({
          worldId: 'world',
          generalId: 3,
          slot,
          commandKey: 'rest',
          args: {},
          explicit: false,
        })),
      ),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    inputEvent: {
      findUnique: vi.fn(async (): Promise<unknown> => null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
  };
  const ctx = {
    user: { id: 'owner', email: 'own@example.test' },
    sessionId: 'session',
    emailVerificationRequired: true,
    db: { $transaction: (run: (tx: unknown) => unknown) => run(tx) },
  } as unknown as Context & { user: NonNullable<Context['user']> };
  vi.mocked(requireWorld).mockResolvedValue(world as unknown as Awaited<ReturnType<typeof requireWorld>>);
  vi.mocked(requireGeneral).mockResolvedValue({ id: 1, turnRevision: 0 } as Awaited<ReturnType<typeof requireGeneral>>);
  vi.mocked(readView).mockResolvedValue(view);
  const input = {
    worldId: 'world',
    requestId: '00000000-0000-4000-8000-000000000001',
    expectedUserId: 'owner',
    payload: { type: 'issue', recipientId: 3, command: { commandKey: 'rest', args: {} }, revision: 0 },
  };
  return { tx, ctx, input, view, world, run: () => submitCampaignOrder(ctx, input) };
}
it.each(['read', 'submit'])(
  'AC-INT-19A %s는 운영 병종과 원생성 사본이 다르면 조회·접수를 거부한다',
  async (operation) => {
    const f = fixture();
    f.world.unitSet = structuredClone(testUnits);
    f.world.unitSet.crewTypes[0]!.name += '변조';
    const before = JSON.stringify(f.view);
    await expect(operation === 'read' ? readCampaignOrders(f.ctx, 'world') : f.run()).rejects.toThrow(
      '휘하 지시의 원생성 기능·병종 사본이 다릅니다.',
    );
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
    expect(f.tx.generalTurn.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.generalTurn.createMany).not.toHaveBeenCalled();
    expect(JSON.stringify(f.view)).toBe(before);
  },
);
it('AC-INT-19A API는 지시·활동 접수만 쓰고 다른 사람의30칸은 바꾸지 않는다', async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({ status: 'pending', requestId: f.input.requestId, userId: 'owner' });
  expect(f.tx.inputEvent.create).toHaveBeenCalledOnce();
  expect(f.tx.inputEvent.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        generalId: 1,
        kind: 'campaign.order',
        payload: f.input.payload,
        status: 'PENDING',
      }),
    }),
  );
  expect(f.tx.generalTurn.deleteMany).not.toHaveBeenCalled();
  expect(f.tx.generalTurn.createMany).not.toHaveBeenCalled();
  expect(f.view.campaign).not.toHaveProperty('orders');
});
it.each(['session', 'inactive', 'verification', 'sanction', 'ABA'])(
  'AC-INT-19A 현재 %s 경계 실패는 접수0이다',
  async (kind) => {
    const f = fixture();
    if (kind === 'session') f.tx.session.findFirst.mockResolvedValue(null);
    if (kind === 'inactive')
      f.tx.session.findFirst.mockResolvedValue({
        user: { status: 'WITHDRAWN', emailVerifiedAt: new Date(), consents: [] },
      });
    if (kind === 'verification')
      f.tx.session.findFirst.mockResolvedValue({ user: { status: 'ACTIVE', emailVerifiedAt: null, consents: [] } });
    if (kind === 'sanction') f.tx.sanction.findFirst.mockResolvedValue({ id: 1 });
    if (kind === 'ABA') f.input.expectedUserId = 'previous-user';
    await expect(f.run()).rejects.toBeDefined();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  },
);
it('AC-INT-19A 같은UUID·같은내용은 기존접수만 돌려주고 내용변경은409이다', async () => {
  const f = fixture();
  f.tx.inputEvent.findUnique.mockResolvedValue({ kind: 'campaign.order', payload: f.input.payload, status: 'PENDING' });
  expect(await f.run()).toMatchObject({ status: 'pending' });
  expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  f.input.payload.recipientId = 4;
  f.tx.inputEvent.findUnique.mockResolvedValue({
    kind: 'campaign.order',
    payload: { ...f.input.payload, recipientId: 3 },
    status: 'PENDING',
  });
  await expect(f.run()).rejects.toHaveProperty('code', 'CONFLICT');
  expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
});
it('AC-INT-19A 조회는 당사자의 발송·수신만 보여주고 현재 본인 첫칸만 반환한다', async () => {
  const f = fixture();
  f.view.campaign!.orders = {
    version: 1,
    nextId: 3,
    items: [
      {
        id: 1,
        issuerId: 1,
        recipientId: 3,
        nationId: 1,
        authority: 'SOVEREIGN',
        command: { commandKey: 'rest', args: {} },
        status: 'PENDING',
        createdTick: 0,
        turnRevision: null,
        firstSlot: null,
        result: null,
        resolvedTick: null,
      },
      {
        id: 2,
        issuerId: 2,
        recipientId: 4,
        nationId: 1,
        authority: 'SOVEREIGN',
        command: { commandKey: 'rest', args: {} },
        status: 'PENDING',
        createdTick: 0,
        turnRevision: null,
        firstSlot: null,
        result: null,
        resolvedTick: null,
      },
    ],
  };
  const result = await readCampaignOrders(f.ctx, 'world');
  expect(result.orders.map((order) => order.id)).toEqual([1]);
  expect(f.tx.generalTurn.findMany).toHaveBeenCalledWith({ where: { worldId: 'world', generalId: 1 } });
  expect(result.next).toEqual({ turnRevision: 0, firstSlot: { commandKey: 'rest', args: {}, explicit: false } });
});
