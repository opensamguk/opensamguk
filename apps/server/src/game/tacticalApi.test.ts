import { describe, it, expect, vi } from 'vitest';
import type { PersonnelActorContext } from './personnelApi';
import { heartbeatTactical, readTactical, tacticalReceipt } from './tacticalApi';
function fixture() {
  const tx = {
    $queryRaw: vi.fn(async () => [{ now: new Date(10000) }]),
    world: { findUnique: vi.fn(async () => ({ id: 'world', status: 'RUNNING' })) },
    session: { findFirst: vi.fn(async () => ({ id: 'session' }) as { id: string } | null) },
    sanction: { findFirst: vi.fn(async () => null as { id: string } | null) },
    general: { findUnique: vi.fn(async () => ({ id: 1, userId: 'user', removedAt: null })) },
    battle: { findUnique: vi.fn(async () => null) },
    inputEvent: { findFirst: vi.fn(async () => null) },
    battlePresence: { upsert: vi.fn() },
  };
  const ctx = {
    user: { id: 'user' },
    sessionId: 'session',
    now: 10000,
    db: { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) },
  } as unknown as PersonnelActorContext;
  return { tx, ctx };
}
describe('AC-INT-28 전술 서비스 접근 경계', () => {
  it('읽기에도 만료·취소된 세션을 검사한다', async () => {
    const { tx, ctx } = fixture();
    tx.session.findFirst.mockResolvedValue(null);
    await expect(readTactical(ctx, { worldId: 'world', battleId: 'secret' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(tx.battle.findUnique).not.toHaveBeenCalled();
  });
  it('월드·전역 제재는 heartbeat와 읽기 모두 거절한다', async () => {
    const { tx, ctx } = fixture();
    tx.sanction.findFirst.mockResolvedValue({ id: 'sanction' });
    await expect(heartbeatTactical(ctx, { worldId: 'world', battleId: 'secret' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(readTactical(ctx, { worldId: 'world', battleId: 'secret' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(tx.battlePresence.upsert).not.toHaveBeenCalled();
  });
  it('다른 사용자의 영수증과 다른 월드의 전투를 숨긴다', async () => {
    const { tx, ctx } = fixture();
    await expect(tacticalReceipt(ctx, { worldId: 'world', receiptId: '12' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(tx.inputEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ worldId: 'world', userId: 'user' }) }),
    );
    await expect(heartbeatTactical(ctx, { worldId: 'world', battleId: 'secret' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(tx.battlePresence.upsert).not.toHaveBeenCalled();
  });
});
