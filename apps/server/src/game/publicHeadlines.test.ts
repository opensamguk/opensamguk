import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../context';
import { lobbyRouter } from '../routers/lobby';

const worldId = '00000000-0000-4000-8000-000000000001';
function fixture(data: unknown = { publicNationEventId: '7' }) {
  const findMany = vi.fn(async (_query: unknown) => {
    void _query;
    return [
      {
        id: 7n,
        tick: 12,
        kind: 'capture',
        text: '옛 나라의 점령',
        nations: [{ id: 1, name: '옛 나라', color: '#123456' }],
      },
    ];
  });
  const findFirst = vi.fn(async (_query: unknown) => {
    void _query;
    return { takenAt: new Date(600_000), data };
  });
  const tx = {
    world: { findUnique: vi.fn(async () => ({ startYear: 191 })) },
    publicMapSnapshot: { findFirst },
    publicNationEvent: { findMany },
  };
  const ctx = {
    db: { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) },
    now: 900_000,
    publicMapConfig: { delayMinutes: 5 },
    user: null,
  } as unknown as Context;
  return { caller: lobbyRouter.createCaller(ctx), tx, findMany, findFirst };
}

describe('AC-M2-20 지연 공개 정세', () => {
  it('무인증 조회는 지도 사본의 사건 ID와 시간 경계를 사용하고 당시 국가를 반환한다', async () => {
    const { caller, findFirst, findMany } = fixture();
    const result = await caller.headlines({ worldId });
    expect(result).toMatchObject({
      worldId,
      delayMinutes: 5,
      takenAt: new Date(600_000).toISOString(),
      items: [{ id: '7', gameDate: { year: 191, month: 1 }, nations: [{ id: 1, name: '옛 나라', color: '#123456' }] }],
    });
    expect(findFirst.mock.calls[0]![0]).toMatchObject({
      where: {
        worldId,
        OR: [{ tick: 0, takenAt: { lte: new Date(900_000) } }, { takenAt: { lte: new Date(600_000) } }],
      },
    });
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        worldId,
        id: { lte: 7n },
        kind: { in: ['found', 'fall', 'declare', 'capture', 'unify', 'disaster', 'boom'] },
      },
      take: 20,
    });
  });
  it.each([{}, { publicNationEventId: '-1' }, null])(
    '사건 경계가 없는 구사본은 실시간 기록으로 대체하지 않는다: %j',
    async (data) => {
      const { caller, findMany } = fixture(data);
      expect((await caller.headlines({ worldId })).items).toEqual([]);
      expect(findMany).not.toHaveBeenCalled();
    },
  );
  it.each([{ worldId, limit: 0 }, { worldId, limit: 51 }, { worldId, userId: 'injected' }, { worldId: '../world' }])(
    '입력 %j는 DB 전에 거절한다',
    async (input) => {
      const { caller, tx } = fixture();
      await expect(caller.headlines(input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(tx.world.findUnique).not.toHaveBeenCalled();
    },
  );
  it('없는 월드는 NOT_FOUND다', async () => {
    const { caller, tx } = fixture();
    tx.world.findUnique.mockResolvedValue(null as never);
    await expect(caller.headlines({ worldId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
