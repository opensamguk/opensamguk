import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@opensamguk/db';
import { applyCityResourceInput } from '@opensamguk/rules';
import { databaseNow } from './lease';
import { loadReplayState } from './monthly';
import { persistEffects } from './persist';
import { processCityResourceInput } from './cityResourceInput';
import type { EngineInput, EngineWorld } from './features';
import { persistForeignCampaignInput } from './campaignInput';
import { builtInEngineFeatures } from './ruleFeatures';

vi.mock('./monthly', () => ({ loadReplayState: vi.fn() }));
vi.mock('./persist', () => ({ persistEffects: vi.fn() }));
vi.mock('./lease', () => ({ databaseNow: vi.fn() }));
vi.mock('./campaignInput', () => ({ persistForeignCampaignInput: vi.fn(), processCampaignQueuedInput: vi.fn() }));
vi.mock('@opensamguk/rules', async (original) => ({
  ...(await original<typeof import('@opensamguk/rules')>()),
  applyCityResourceInput: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async (): Promise<{ status: string } | null> => ({ status: 'ACTIVE' })) },
    sanction: { findFirst: vi.fn(async (): Promise<object | null> => null) },
  };
  const world = { id: 'own-world', status: 'RUNNING' } as EngineWorld;
  const event = {
    id: 1n,
    worldId: 'own-world',
    status: 'PENDING',
    sequence: null,
    tick: null,
    stepTick: null,
    result: null,
    createdAt: new Date('2026-10-29T00:00:00Z'),
    idempotencyKey: 'city.resources:test',
    kind: 'city.resources',
    userId: 'session-user',
    generalId: 2,
    payload: { cityKey: 1, unitId: 3, crewType: 1100, amount: 5 },
  } as EngineInput;
  const state = { generals: {} } as unknown as Awaited<ReturnType<typeof loadReplayState>>['state'];
  vi.mocked(loadReplayState).mockResolvedValue({
    state,
    turns: {},
    revisions: {},
    monthlyTick: 0,
    campaignArmyTypes: [1100],
  });
  vi.mocked(databaseNow).mockResolvedValue(new Date('2026-10-29T00:00:00Z'));
  const run = () =>
    processCityResourceInput(tx as unknown as Prisma.TransactionClient, world, event, { tick: 123, sequence: 9 });
  return { tx, world, event, state, run };
}
describe('AC-INT-18B 도시 배속 입력의 엔진 경계', () => {
  it('같은 잠금 사본을 순수 규칙과 저장에 넘기고 예약은 직접 쓰지 않는다', async () => {
    const f = fixture();
    const next = { ...f.state, cityResources: { version: 1 as const, cities: {} } };
    const result = { ...(f.event.payload as object), revision: 8, tick: 123 };
    vi.mocked(applyCityResourceInput).mockReturnValue({ ok: true, state: next, result, text: '배속' } as ReturnType<
      typeof applyCityResourceInput
    >);
    expect(await f.run()).toEqual({ status: 'APPLIED', result });
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(applyCityResourceInput).toHaveBeenCalledExactlyOnceWith(f.state, f.event.payload, 2, {
      tick: 123,
      userId: 'session-user',
      userActive: true,
      armyTypes: [1100],
    });
    expect(persistEffects).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      'own-world',
      next,
      [{ kind: 'world', state: next }],
      { tick: 123, sequence: 9 },
      f.state,
    );
  });
  it.each(['PREOPEN', 'PAUSED', 'ENDED'] as const)('%s 월드는 읽거나 적용하지 않는다', async (status) => {
    const f = fixture();
    f.world.status = status;
    expect(await f.run()).toMatchObject({ status: 'REJECTED', result: { code: 'WORLD_CLOSED' } });
    expect(f.tx.user.findUnique).not.toHaveBeenCalled();
    expect(persistEffects).not.toHaveBeenCalled();
  });
  it.each([null, { status: 'WITHDRAWN' }])('활성 계정을 다시 확인한다 (%s)', async (user) => {
    const f = fixture();
    f.tx.user.findUnique.mockResolvedValue(user);
    expect(await f.run()).toMatchObject({ status: 'REJECTED', result: { code: 'ACTOR_INACTIVE' } });
    expect(loadReplayState).not.toHaveBeenCalled();
  });
  it('대기 중 추가한 전역·월드 제재를 DB 시각으로 다시 검사한다', async () => {
    const f = fixture();
    f.tx.sanction.findFirst.mockResolvedValue({ id: 'sanction' });
    expect(await f.run()).toMatchObject({ status: 'REJECTED', result: { code: 'ACTOR_SANCTIONED' } });
    expect(f.tx.sanction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'session-user',
          liftedAt: null,
          AND: [
            { OR: [{ worldId: null }, { worldId: 'own-world' }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date('2026-10-29T00:00:00Z') } }] },
          ],
        }),
      }),
    );
    expect(loadReplayState).not.toHaveBeenCalled();
  });
  it('장수가 없거나 규칙에서 소유권·집결·잔량을 거부하면 저장하지 않는다', async () => {
    const f = fixture();
    f.event.generalId = null;
    expect(await f.run()).toMatchObject({ status: 'REJECTED', result: { code: 'NO_GENERAL' } });
    f.event.generalId = 2;
    vi.mocked(applyCityResourceInput).mockReturnValue({ ok: false, code: 'NO_CREW', message: '부족' });
    expect(await f.run()).toEqual({ status: 'REJECTED', result: { code: 'NO_CREW', message: '부족' } });
    expect(persistEffects).not.toHaveBeenCalled();
  });
  it('다른 입력 종류와 저장 실패를 삼키지 않는다', async () => {
    const f = fixture();
    f.event.kind = 'campaign.unit';
    await expect(f.run()).rejects.toThrow('종류');
    f.event.kind = 'city.resources';
    vi.mocked(applyCityResourceInput).mockReturnValue({ ok: true, state: f.state, result: {}, text: '' } as ReturnType<
      typeof applyCityResourceInput
    >);
    vi.mocked(persistEffects).mockRejectedValue(new Error('city-cas-failed'));
    await expect(f.run()).rejects.toThrow('city-cas-failed');
  });
  it('도시 handler 뒤 campaign이 이전 JSON을 중복 CAS하지 않고 인사 후처리는 유지한다', async () => {
    const f = fixture();
    const before = vi.mocked(loadReplayState).getMockImplementation()!;
    const replay = await before({} as Prisma.TransactionClient, 'own-world');
    const campaign = builtInEngineFeatures.find((feature) => feature.key === 'campaign-v1')!;
    const input = {
      sequence: 9,
      tick: 123,
      generalId: 2,
      kind: 'city.resources',
      status: 'APPLIED' as const,
      payload: f.event.payload,
      result: {},
    };
    await campaign.afterQueuedInput!(f.tx as unknown as Prisma.TransactionClient, f.world, replay, input);
    expect(persistForeignCampaignInput).not.toHaveBeenCalled();
    await campaign.afterQueuedInput!(f.tx as unknown as Prisma.TransactionClient, f.world, replay, {
      ...input,
      kind: 'general.active',
    });
    expect(persistForeignCampaignInput).toHaveBeenCalledOnce();
    expect(builtInEngineFeatures.find((feature) => feature.key === 'personnel')!.afterQueuedInput).toBeTypeOf(
      'function',
    );
  });
});
