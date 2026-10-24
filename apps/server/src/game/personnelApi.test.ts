import type { PrismaClient } from '@opensamguk/db';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitPersonnelRequest } from './personnelAdmission';
import { submitAndWaitPersonnel } from './personnelApi';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }));
vi.mock('./personnelAdmission', async (original) => ({
  ...(await original<typeof import('./personnelAdmission')>()),
  submitPersonnelRequest: vi.fn(async () => ({ created: true })),
}));
let elapsed = 0;
beforeEach(() => {
  vi.clearAllMocks();
  elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  vi.mocked(delay).mockImplementation(async () => {
    elapsed += 100;
  });
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const requestId = '10000000-0000-4000-8000-000000000001';
  const pending = {
    kind: 'personnel.appoint',
    status: 'PENDING',
    result: null,
    idempotencyKey: `personnel:${requestId}`,
  };
  const tx = {
    session: { findFirst: vi.fn(async (): Promise<object | null> => ({ id: 'session' })) },
    world: { findUnique: vi.fn(async () => ({ id: 'world', replayFormat: 3, ruleFeatures: ['personnel'] })) },
    inputEvent: {
      findUnique: vi.fn(
        async () => pending as { kind: string; status: string; result: unknown; idempotencyKey: string },
      ),
    },
  };
  const transaction = vi.fn(async (run: (value: typeof tx) => unknown) => run(tx));
  const ctx = {
    db: { $transaction: transaction } as unknown as PrismaClient,
    user: { id: 'user' },
    sessionId: 'session',
    now: 1000,
  };
  const run = () =>
    submitAndWaitPersonnel(ctx, {
      worldId: 'world',
      requestId,
      kind: 'personnel.appoint',
      payload: { generalId: 3, officerLevel: 5 },
    });
  return { ctx, tx, pending, run };
}
describe('인사 접수 결과 대기와 세션 재확인', () => {
  it('접수 뒤 pending에서 applied로 바뀌면 같은 요청의 결과를 돌려준다', async () => {
    const f = fixture();
    f.tx.inputEvent.findUnique.mockResolvedValueOnce(f.pending).mockResolvedValue({
      ...f.pending,
      status: 'APPLIED',
      result: { generalId: 3, officerLevel: 5, title: '수뇌', tick: 105 },
    });
    expect(await f.run()).toEqual({
      status: 'applied',
      requestId: f.pending.idempotencyKey.slice(10),
      result: { generalId: 3, officerLevel: 5, title: '수뇌' },
    });
    expect(submitPersonnelRequest).toHaveBeenCalledOnce();
    expect(f.tx.session.findFirst.mock.calls[1]).toEqual([
      expect.objectContaining({ where: expect.objectContaining({ expiresAt: { gt: new Date(1100) } }) }),
    ]);
  });
  it('대기 중 세션이 사라지면 두 번째 결과를 읽지 않고 UNAUTHORIZED다', async () => {
    const f = fixture();
    f.tx.session.findFirst.mockResolvedValueOnce({ id: 'session' }).mockResolvedValue(null);
    await expect(f.run()).rejects.toHaveProperty('code', 'UNAUTHORIZED');
    expect(f.tx.inputEvent.findUnique).toHaveBeenCalledOnce();
  });
  it('5초가 지나도 미처리면 pending을 돌려주고 접수는 다시 만들지 않는다', async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ status: 'pending', requestId: f.pending.idempotencyKey.slice(10) });
    expect(elapsed).toBe(5000);
    expect(submitPersonnelRequest).toHaveBeenCalledOnce();
  });
  it('발령이 엔진에서 닫혔으면 변경 요청은 CONFLICT 오류를 낸다', async () => {
    const f = fixture();
    f.tx.inputEvent.findUnique.mockResolvedValue({
      ...f.pending,
      kind: 'offer.respond',
      status: 'REJECTED',
      result: { code: 'OFFER_CLOSED', message: '끝난 제안' },
    });
    await expect(
      submitAndWaitPersonnel(f.ctx, {
        worldId: 'world',
        requestId: f.pending.idempotencyKey.slice(10),
        kind: 'offer.respond',
        payload: { offerId: 'offer', accept: true },
      }),
    ).rejects.toHaveProperty('code', 'CONFLICT');
  });
});
