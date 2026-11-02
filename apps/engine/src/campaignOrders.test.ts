import { beforeEach, expect, it, vi } from 'vitest';
import type { Prisma } from '@opensamguk/db';
import { applyCampaignOrder, unitSetSchema } from '@opensamguk/rules';
import { readFileSync } from 'node:fs';
import { processCampaignQueuedInput } from './campaignInput';
import { loadReplayState } from './monthly';
import { persistEffects } from './persist';
import { databaseNow } from './lease';
import type { EngineInput, EngineWorld } from './features';
const testUnits = unitSetSchema.parse(
  JSON.parse(readFileSync(new URL('../../../resources/unitset/basic.json', import.meta.url), 'utf8')),
);

vi.mock('./monthly', () => ({ loadReplayState: vi.fn() }));
vi.mock('./persist', () => ({ persistEffects: vi.fn() }));
vi.mock('./lease', () => ({ databaseNow: vi.fn() }));
vi.mock('@opensamguk/rules', async (original) => ({
  ...(await original<typeof import('@opensamguk/rules')>()),
  applyCampaignOrder: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async (): Promise<{ status: string } | null> => ({ status: 'ACTIVE' })) },
    sanction: { findFirst: vi.fn(async (): Promise<object | null> => null) },
  };
  const world = { id: 'world', status: 'RUNNING', unitSet: testUnits } as unknown as EngineWorld;
  const event = {
    kind: 'campaign.order',
    generalId: 1,
    userId: 'owner',
    payload: { type: 'request', revision: 0 },
  } as unknown as EngineInput;
  const state = {
    ruleFeatures: ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'],
    generals: {},
  } as unknown as Awaited<ReturnType<typeof loadReplayState>>['state'];
  const replay = { state, turns: {}, revisions: {}, monthlyTick: 0 };
  vi.mocked(loadReplayState).mockResolvedValue(replay);
  vi.mocked(databaseNow).mockResolvedValue(new Date('2026-10-30T00:00:00Z'));
  const run = () =>
    processCampaignQueuedInput(tx as unknown as Prisma.TransactionClient, world, event, { tick: 1, sequence: 2 });
  return { tx, world, event, replay, run };
}
it('AC-INT-19B 같은 잠금 사본의30칸·revision을 전달하고 원장·효과만 같은 트랜잭션에 저장한다', async () => {
  const f = fixture(),
    next = { ...f.replay.state },
    result = { orderId: 1, revision: 1 };
  vi.mocked(applyCampaignOrder).mockReturnValue({ ok: true, state: next, result });
  expect(await f.run()).toEqual({ status: 'APPLIED', result: { ...result, tick: 1 } });
  expect(applyCampaignOrder).toHaveBeenCalledExactlyOnceWith(
    f.replay.state,
    f.event.payload,
    1,
    expect.objectContaining({
      turns: f.replay.turns,
      revisions: f.replay.revisions,
      tick: 1,
      userId: 'owner',
      unitSet: testUnits,
    }),
  );
  expect(persistEffects).toHaveBeenCalledExactlyOnceWith(
    f.tx,
    'world',
    next,
    [{ kind: 'world', state: next }],
    { tick: 1, sequence: 2 },
    f.replay.state,
  );
});
it.each(['PREOPEN', 'PAUSED', 'ENDED'] as const)('AC-INT-19B %s에서는 지시가 적용되지 않는다', async (status) => {
  const f = fixture();
  f.world.status = status;
  expect(await f.run()).toMatchObject({ status: 'REJECTED', result: { code: 'WORLD_CLOSED' } });
  expect(applyCampaignOrder).not.toHaveBeenCalled();
  expect(persistEffects).not.toHaveBeenCalled();
});
it.each([null, { status: 'WITHDRAWN' }])('AC-INT-19B 현재 활성 계정이 아니면 적용0 (%j)', async (user) => {
  const f = fixture();
  f.tx.user.findUnique.mockResolvedValue(user);
  expect(await f.run()).toMatchObject({ status: 'REJECTED', result: { code: 'ACTOR_INACTIVE' } });
  expect(loadReplayState).not.toHaveBeenCalled();
});
it('AC-INT-19B 접수 뒤 제재가 생기면 현재 DB시간의 전역·월드 제재를 다시 검사한다', async () => {
  const f = fixture();
  f.tx.sanction.findFirst.mockResolvedValue({ id: 'sanction' });
  expect(await f.run()).toMatchObject({ status: 'REJECTED', result: { code: 'ACTOR_SANCTIONED' } });
  expect(f.tx.sanction.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        userId: 'owner',
        AND: [
          { OR: [{ worldId: null }, { worldId: 'world' }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date('2026-10-30T00:00:00Z') } }] },
        ],
      }),
    }),
  );
  expect(loadReplayState).not.toHaveBeenCalled();
});
it('AC-INT-19B 엔진 저장 오류는 성공 영수증으로 바꾸지 않고 외부 트랜잭션에 전파한다', async () => {
  const f = fixture();
  vi.mocked(applyCampaignOrder).mockReturnValue({
    ok: true,
    state: f.replay.state,
    result: { orderId: 1, revision: 1 },
  });
  const failure = new Error('rollback-test');
  vi.mocked(persistEffects).mockRejectedValue(failure);
  await expect(f.run()).rejects.toBe(failure);
});
