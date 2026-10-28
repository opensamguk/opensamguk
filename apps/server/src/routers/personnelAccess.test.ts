import { describe, expect, it, vi } from 'vitest';
import { appRouter } from '../router';
import type { Context } from '../context';

type Caller = ReturnType<typeof appRouter.createCaller>;
const worldId = 'world';
const requestId = '10000000-0000-4000-8000-000000000001';
const office = { nationId: 1, officerLevel: 5, tenure: 0 };
const slots = Array.from({ length: 12 }, () => null);
function fixture(authenticated = false) {
  const sanction = vi.fn().mockResolvedValue(null);
  const transaction = vi.fn(() => {
    throw new Error('DB에 도달하면 안 됩니다.');
  });
  const ctx = {
    user: authenticated ? { id: 'user', email: 'user@example.test' } : null,
    db: { $transaction: transaction, sanction: { findFirst: sanction } },
    now: 1000,
    rateLimiter: { consume: () => ({ allowed: true }) },
    reply: { header: vi.fn() },
  } as unknown as Context;
  return { caller: appRouter.createCaller(ctx), transaction, sanction };
}
const unauthenticated: Array<[string, (caller: Caller) => Promise<unknown>]> = [
  ['personnel.officers', (c) => c.personnel.officers({ worldId })],
  ['personnel.appoint', (c) => c.personnel.appoint({ worldId, requestId, generalId: 3, officerLevel: 5 })],
  ['personnel.dismiss', (c) => c.personnel.dismiss({ worldId, requestId, generalId: 3 })],
  ['personnel.request', (c) => c.personnel.request({ worldId, requestId })],
  ['personnel.recent', (c) => c.personnel.recent({ worldId })],
  ['offers.mine', (c) => c.offers.mine({ worldId })],
  ['offers.respond', (c) => c.offers.respond({ worldId, requestId, offerId: 'offer', accept: true })],
  ['nationTurns.get', (c) => c.nationTurns.get({ worldId })],
  ['nationTurns.set', (c) => c.nationTurns.set({ worldId, office, revision: 0, slots })],
  ['nationTurns.edit', (c) => c.nationTurns.edit({ worldId, office, revision: 0, op: { shift: 1 } })],
  ['nationCommands.list', (c) => c.nationCommands.list({ worldId })],
  ['nationCommands.precheck', (c) => c.nationCommands.precheck({ worldId, commandKey: 'nation_rest' })],
];
describe('실제 인사 router의 인증과 입력 경계', () => {
  it.each(unauthenticated)('%s는 무인증이면 DB 전에 거부한다', async (_name, run) => {
    const f = fixture();
    await expect(run(f.caller)).rejects.toHaveProperty('code', 'UNAUTHORIZED');
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.sanction).not.toHaveBeenCalled();
  });
  const invalid: Array<[string, (caller: Caller) => Promise<unknown>]> = [
    ['군주 임명', (c) => c.personnel.appoint({ worldId, requestId, generalId: 3, officerLevel: 12 })],
    ['없는 대상 번호', (c) => c.personnel.dismiss({ worldId, requestId, generalId: 0 })],
    ['11칸', (c) => c.nationTurns.set({ worldId, office, revision: 0, slots: slots.slice(1) })],
    ['움직이지 않는 shift', (c) => c.nationTurns.edit({ worldId, office, revision: 0, op: { shift: 0 } })],
    [
      '표시용 칸 이름',
      (c) =>
        c.nationTurns.set({
          worldId,
          office,
          revision: 0,
          slots: [{ commandKey: 'nation_rest', args: {}, name: '표시' }, ...slots.slice(1)],
        } as Parameters<Caller['nationTurns']['set']>[0]),
    ],
    [
      '클라이언트 행위자',
      (c) =>
        c.personnel.dismiss({ worldId, requestId, generalId: 3, userId: 'other' } as Parameters<
          Caller['personnel']['dismiss']
        >[0]),
    ],
  ];
  it.each(invalid)('%s는 게임 DB 변경과 활동 기록 전에 거부한다', async (_name, run) => {
    const f = fixture(true);
    await expect(run(f.caller)).rejects.toHaveProperty('code', 'BAD_REQUEST');
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.sanction).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user', worldId }) }),
    );
  });
});
