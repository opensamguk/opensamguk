import { describe, it, expect, vi } from 'vitest';
import type { Context } from '../context';
import { battleRouter } from './battle';
import { readTactical, submitTactical, heartbeatTactical, tacticalReceipt } from '../game/tacticalApi';
vi.mock('../game/tacticalApi', async () => {
  const actual = await vi.importActual<typeof import('../game/tacticalApi')>('../game/tacticalApi');
  return {
    ...actual,
    readTactical: vi.fn(async () => ({ id: 'battle', frames: [] })),
    submitTactical: vi.fn(async () => ({ receiptId: '1', status: 'PENDING' })),
    heartbeatTactical: vi.fn(async () => ({ expiresAt: 'time' })),
    tacticalReceipt: vi.fn(async () => ({ status: 'APPLIED' })),
  };
});
const base = { worldId: 'world', battleId: 'battle' };
const envelope = { ...base, expectedRevision: 0, windowNo: 0, mapHash: 'map', idempotencyKey: 'key' };
function context() {
  return {
    user: { id: 'user', email: 'user@example.test' },
    sessionId: 'session',
    db: { sanction: { findFirst: vi.fn(async () => null) } },
    rateLimiter: { consume: () => ({ allowed: true }) },
  } as unknown as Context;
}
describe('AC-INT-28 전술 tRPC 8개 계약', () => {
  it('여덟 경로를 인증된 컨텍스트와 검증한 입력으로 연결한다', async () => {
    const ctx = context(),
      caller = battleRouter.createCaller(ctx);
    await caller.council.get(base);
    await caller.turn.get(base);
    await caller.replay.get({ ...base, afterTurn: 0, limit: 5 });
    await caller.council.set({ ...envelope, ready: true, route: 'front' });
    await caller.plan.set({ ...envelope, units: [{ unitId: 1, path: [], rules: [], fallback: { kind: 'hold' } }] });
    await caller.turn.submit({
      ...envelope,
      turnNo: 1,
      unitId: 1,
      expectedUnitOrderRevision: 0,
      action: { kind: 'attack', target: -1100 },
    });
    await caller.presence.heartbeat(base);
    await caller.receipt.get({ worldId: 'world', receiptId: '1' });
    expect(readTactical).toHaveBeenCalledWith(
      expect.objectContaining({ user: ctx.user }),
      expect.objectContaining(base),
      true,
    );
    expect(submitTactical).toHaveBeenCalledWith(
      expect.objectContaining({ user: ctx.user }),
      'battle.turn',
      expect.objectContaining({ action: { kind: 'attack', target: -1100 } }),
    );
    expect(heartbeatTactical).toHaveBeenCalled();
    expect(tacticalReceipt).toHaveBeenCalled();
  });
  it('모든 조회와 입력이 로그인을 요구한다', async () => {
    const caller = battleRouter.createCaller({ ...context(), user: null });
    await expect(caller.council.get(base)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.turn.get(base)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.replay.get(base)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.council.set({ ...envelope, ready: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.plan.set({ ...envelope, units: [] })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller.turn.submit({ ...envelope, turnNo: 1, unitId: 1, expectedUnitOrderRevision: 0, action: { kind: 'hold' } }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.presence.heartbeat(base)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.receipt.get({ worldId: 'world', receiptId: '1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
  it('외부 행위자·31턴·과도한 페이지·0 대상·65칸 경로를 거절한다', async () => {
    const caller = battleRouter.createCaller(context());
    await expect(caller.council.get({ ...base, generalId: 2 } as typeof base)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller.turn.submit({
        ...envelope,
        turnNo: 31,
        unitId: 1,
        expectedUnitOrderRevision: 0,
        action: { kind: 'hold' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.replay.get({ ...base, limit: 6 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.turn.submit({
        ...envelope,
        turnNo: 1,
        unitId: 1,
        expectedUnitOrderRevision: 0,
        action: { kind: 'attack', target: 0 },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.plan.set({
        ...envelope,
        units: [
          {
            unitId: 1,
            path: Array.from({ length: 65 }, () => ({ x: 1, y: 1 })),
            rules: [],
            fallback: { kind: 'hold' },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
