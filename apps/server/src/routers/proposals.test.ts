import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../context';
import { proposalsRouter } from './proposals';

function fixture() {
  const tx = {
    session: { findFirst: vi.fn(async () => ({ id: 'session' }) as { id: string } | null) },
    commandProposal: { findUnique: vi.fn(async () => ({ worldId: 'world' })) },
    sanction: { findFirst: vi.fn(async () => null as { id: string } | null) },
  };
  const ctx = {
    user: { id: 'user', email: 'user@example.test' },
    sessionId: 'session',
    now: 1000,
    db: { $transaction: async (fn: (db: unknown) => unknown) => fn(tx), sanction: tx.sanction },
    rateLimiter: { consume: () => ({ allowed: true }) },
  } as unknown as Context;
  return { tx, ctx, caller: proposalsRouter.createCaller(ctx) };
}
const proposalId = '10000000-0000-4000-8000-000000000001';
describe('AC-M1-14 상신 API 인증·입력 경계', () => {
  it('worldId가 없는 응답·취소도 저장된 제안 월드의 제재를 검사한다', async () => {
    const f = fixture();
    f.tx.sanction.findFirst.mockResolvedValue({ id: 'blocked' });
    await expect(f.caller.respond({ proposalId, decision: 'approve', slot: 0 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(f.caller.cancel({ proposalId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.tx.sanction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ worldId: 'world', userId: 'user' }) }),
    );
  });
  it('만료된 세션과 로그인 없는 조회를 거부한다', async () => {
    const f = fixture();
    f.tx.session.findFirst.mockResolvedValue(null);
    await expect(f.caller.cancel({ proposalId })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      proposalsRouter.createCaller({ ...f.ctx, user: null }).list({ worldId: 'world', box: 'sent' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('칸 범위·200자 초과 사유·외부 행위자 주입을 거부한다', async () => {
    const f = fixture();
    await expect(f.caller.create({ worldId: 'world', commandKey: 'nation_reward', slot: 12 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(f.caller.respond({ proposalId, decision: 'reject', reason: '가'.repeat(201) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      f.caller.cancel({ proposalId, generalId: 1 } as Parameters<typeof f.caller.cancel>[0]),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.tx.commandProposal.findUnique).not.toHaveBeenCalled();
  });
});
