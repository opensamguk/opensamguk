import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@opensamguk/db';
import type { Context } from '../context';
import { treatyRouter } from '../routers/treaty';
import { listTradeTargets } from './treatyTrade';

function fixture() {
  const world = {
    id: 'world',
    status: 'RUNNING',
    replayFormat: 3,
    ruleFeatures: ['treaty', 'treaty-trade'],
    startYear: 191,
    actionSequence: 30,
    clockTick: 20000,
  };
  const actor = { id: 1, cityKey: 1, nationId: 1 as number | null, userId: 'owner' };
  const home = { cityKey: 1, nationId: 1, connections: [2] };
  const row = {
    id: 10,
    worldId: 'world',
    fromNationId: 1,
    toNationId: 2,
    clauses: [{ kind: 'trade', months: 2 }],
    status: 'ACTIVE',
    proposedTick: 100,
    respondByTick: 60100,
    startTick: 15000,
    endTick: 35000,
    costFrom: 34,
    costTo: 17,
    closedSequence: null,
  };
  const nations = [
    { id: 1, name: '국가1', color: '#f00', gold: 123456 },
    { id: 2, name: '국가2', color: '#00f', gold: 999999 },
  ];
  const diplomacies: Array<{ nationA: number; nationB: number; state: string }> = [];
  const tx = {
    session: { findFirst: vi.fn(async () => ({ id: 'session' })) },
    world: { findUnique: vi.fn(async () => world) },
    general: {
      findUnique: vi.fn(async (query: { where: { worldId_userId: { userId: string } } }) =>
        query.where.worldId_userId.userId === actor.userId ? actor : null,
      ),
    },
    city: {
      findUnique: vi.fn(async () => home),
      findMany: vi.fn(async () => [{ cityKey: 2, name: '도시2', nationId: 2, commerce: 98765 }]),
    },
    nation: { findMany: vi.fn(async () => nations) },
    diplomacy: { findMany: vi.fn(async () => diplomacies) },
    treaty: { findMany: vi.fn(async () => [row]) },
  };
  const client = tx as unknown as Prisma.TransactionClient;
  const query = () => listTradeTargets(client, { worldId: 'world', userId: 'owner' });
  const context = {
    db: { $transaction: vi.fn(async (callback: (tx: Prisma.TransactionClient) => unknown) => callback(client)) },
    user: { id: 'owner', email: 'owner@example.test' },
    sessionId: 'session',
    now: 1000,
  } as unknown as Context;
  return { world, actor, home, row, nations, diplomacies, tx, client, query, context };
}

describe('T2-07 / AC-M2-14 교역 후보 API leaf', () => {
  it('DTO는 공개 칸만 내보내며 상대 상업과 국고를 조회하지 않는다', async () => {
    const f = fixture();
    const result = await f.query();
    expect(result).toEqual({
      fromCityKey: 1,
      items: [
        {
          cityKey: 2,
          cityName: '도시2',
          nation: { id: 2, name: '국가2', color: '#00f' },
          treatyId: '10',
          tradeEndsAt: { year: 191, month: 4 },
        },
      ],
      blocked: null,
    });
    expect(f.tx.city.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { cityKey: true, name: true, nationId: true, kind: true } }),
    );
    expect(f.tx.nation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, name: true, color: true } }),
    );
    expect(JSON.stringify(result)).not.toMatch(/commerce|gold|rice|98765|999999/);
  });
  it('교역 기능이 없으면 저장 행을 읽기 전에 거절한다', async () => {
    const f = fixture();
    f.world.ruleFeatures = ['treaty'];
    await expect(f.query()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(f.tx.treaty.findMany).not.toHaveBeenCalled();
  });
  it.each(['nation', 'city', 'ended'] as const)('%s 조건에서는 이유와 빈 후보를 반환한다', async (mode) => {
    const f = fixture();
    if (mode === 'nation') f.actor.nationId = null;
    if (mode === 'city') f.home.nationId = 2;
    if (mode === 'ended') f.world.status = 'ENDED';
    expect(await f.query()).toMatchObject({ items: [], blocked: expect.any(String) });
    expect(f.tx.treaty.findMany).not.toHaveBeenCalled();
  });
  it.each(['war', 'expired', 'removed'] as const)('%s 후보는 내보내지 않는다', async (mode) => {
    const f = fixture();
    if (mode === 'war') f.diplomacies.push({ nationA: 1, nationB: 2, state: 'WAR' });
    if (mode === 'expired') f.world.clockTick = 40000;
    if (mode === 'removed') f.nations.pop();
    expect(await f.query()).toMatchObject({ items: [], blocked: expect.any(String) });
  });
  it('조약 저장 파손을 빈 후보로 숨기지 않는다', async () => {
    const f = fixture();
    f.row.endTick++;
    await expect(f.query()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
  it('실제 라우터가 세션의 계정으로 조회하고 RepeatableRead를 쓴다', async () => {
    const f = fixture();
    expect((await treatyRouter.createCaller(f.context).tradeTargets({ worldId: 'world' })).items).toHaveLength(1);
    expect(f.tx.general.findUnique).toHaveBeenCalledWith({
      where: { worldId_userId: { worldId: 'world', userId: 'owner' } },
    });
    expect(f.context.db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
  });
  it('무인증 요청을 막는다', async () => {
    const f = fixture();
    f.context.user = null;
    await expect(treatyRouter.createCaller(f.context).tradeTargets({ worldId: 'world' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(f.tx.world.findUnique).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'sanctioned'] as const)('%s 세션은 실제 라우터에서 막힌다', async () => {
    const f = fixture();
    f.tx.session.findFirst.mockImplementation(async () => null!);
    await expect(treatyRouter.createCaller(f.context).tradeTargets({ worldId: 'world' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(f.tx.session.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'owner', user: { status: 'ACTIVE' } }) }),
    );
    expect(f.tx.world.findUnique).not.toHaveBeenCalled();
  });
  it('다른 계정은 원래 장수의 후보를 읽지 못한다', async () => {
    const f = fixture();
    f.context.user!.id = 'other';
    await expect(treatyRouter.createCaller(f.context).tradeTargets({ worldId: 'world' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(f.tx.city.findUnique).not.toHaveBeenCalled();
  });
  it('클라이언트 행위자 ID를 받지 않는다', async () => {
    const f = fixture();
    await expect(
      treatyRouter.createCaller(f.context).tradeTargets({ worldId: 'world', userId: 'owner' } as { worldId: string }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
