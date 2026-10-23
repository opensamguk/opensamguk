import { beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@opensamguk/db';
import type { Lease } from './lease';
import { processPendingInput } from './inputs';
import { TurnLoop } from './turnLoop';

vi.mock('./inputs', () => ({ processPendingInput: vi.fn().mockResolvedValue(null) }));
vi.mock('./worldLoader', () => ({ loadWorld: vi.fn().mockResolvedValue({}) }));
vi.mock('./lease', async (original) => ({
  ...(await original<typeof import('./lease')>()),
  lockLease: vi.fn(),
  assertLease: vi.fn(),
  databaseNow: vi.fn().mockResolvedValue(new Date(0)),
}));

beforeEach(() => vi.clearAllMocks());

// 정상 호출의 기준 인자만 본다. 전환 원자성은 소유 fixture의 실제 PG 시험으로 검증한다.
function fixture(status: 'PAUSED' | 'RUNNING', human: boolean, modern = false) {
  const world = {
    id: 'binding-world',
    status,
    policyFromSequence: modern ? 0 : null,
    actionSequence: 7,
    clockTick: 600,
    clockAnchorAt: new Date(0),
    clockMode: 'REALTIME',
    monthlyTick: 0,
    startYear: 190,
    turnTermMinutes: 30,
  };
  const tx = {
    $queryRaw: vi.fn(),
    world: { findUniqueOrThrow: vi.fn().mockResolvedValue(world) },
    general: { findFirst: vi.fn().mockResolvedValue(human ? { id: 1 } : null) },
  };
  const db = { $transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)) };
  const loop = new TurnLoop(db as unknown as PrismaClient, { worldId: world.id } as Lease);
  return { world, tx, run: () => loop.advanceTo(999) };
}

it.each(['PAUSED', 'RUNNING'] as const)('%s 정상 사람 호출은 지평과 구분한 잠근 T를 넘긴다', async (status) => {
  const f = fixture(status, true);
  await f.run();
  expect(processPendingInput).toHaveBeenCalledExactlyOnceWith(f.tx, f.world, status === 'PAUSED' ? 600 : 999, 600);
  expect(f.tx.general.findFirst).toHaveBeenCalledExactlyOnceWith({
    where: { worldId: f.world.id, userId: { not: null } },
    select: { id: true },
  });
});

it.each(['PAUSED', 'RUNNING'] as const)('%s 정상 NPC 호출에는 사람 기준을 넣지 않는다', async (status) => {
  const f = fixture(status, false);
  await f.run();
  expect(processPendingInput).toHaveBeenCalledExactlyOnceWith(
    f.tx,
    f.world,
    status === 'PAUSED' ? 600 : 999,
    undefined,
  );
});

it.each(['PAUSED', 'RUNNING'] as const)('%s 방침 모드는 사람 기준 조회를 더하지 않는다', async (status) => {
  const f = fixture(status, true, true);
  await f.run();
  expect(processPendingInput).toHaveBeenCalledExactlyOnceWith(
    f.tx,
    f.world,
    status === 'PAUSED' ? 600 : 999,
    undefined,
  );
  expect(f.tx.general.findFirst).not.toHaveBeenCalled();
});
