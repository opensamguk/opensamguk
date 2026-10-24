import type { Prisma, PrismaClient } from '@opensamguk/db';
import { capsResourceHashInput, type CapsOrigin } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { afterEach, expect, it, vi } from 'vitest';
import legacy from '../test/fixtures/replay-v1-b8f5074.json';
import * as inputs from './inputs';
import { LeaseLostError, type Lease } from './lease';
import { TurnLoop } from './turnLoop';

afterEach(() => vi.restoreAllMocks());
type World = Prisma.WorldGetPayload<Record<string, never>>;
type Event = Prisma.InputEventGetPayload<Record<string, never>>;
const statuses = ['PREOPEN', 'RUNNING', 'PAUSED', 'ENDED'] as const;

// 실제 lease 함수·gate·입력 분배를 호출하는 단위 TX다. DB 잠금과 롤백의 증거가 아니다.
function fixture(status: World['status'] = 'PAUSED', caps = false, beforeCommit?: () => Promise<void>) {
  const origin = { ...legacy.origin, version: 6, capabilities: { version: 1, treaty: { version: 1 } } } as CapsOrigin;
  origin.resourceHash = hashState(capsResourceHashInput(origin));
  const world = {
    id: 'world',
    status,
    preset: null,
    treatyFormat: caps ? 1 : null,
    personnelFormat: null,
    replayOrigin: caps ? origin : null,
    policyFromSequence: null,
    actionSequence: 0,
    startYear: legacy.origin.initial.startYear,
    endYear: null,
    outcomeFromSequence: 0,
    commandMeta: null,
    turnTermMinutes: 30,
    monthlyTick: 0,
    clockTick: 600,
    clockMode: 'REALTIME',
    clockAnchorAt: new Date(0),
    clockRevision: 0,
  } as unknown as World;
  const rows: Record<string, unknown>[] = [];
  const events: Event[] = [];
  const trace: string[] = [];
  let worldLocked = false;
  let fenceChecks = 0;
  let failFence = 0;
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?').trim().replace(/\s+/g, ' ');
    if (sql.startsWith('SELECT "worldId" FROM "EngineLease"')) {
      trace.push('lease-lock');
      return [];
    }
    if (sql.startsWith('SELECT 1 FROM "EngineLease"')) {
      trace.push('fence');
      return ++fenceChecks === failFence ? [] : [{}];
    }
    if (sql === 'SELECT id FROM "World" WHERE id = ? FOR UPDATE') {
      expect(values).toEqual([world.id]);
      worldLocked = true;
      trace.push('world-lock');
      return [];
    }
    if (sql.includes('FROM "WorldExtSlice"')) {
      trace.push('ext-read');
      return [];
    }
    if (sql.startsWith('SELECT clock_timestamp()')) return [{ now: new Date(0) }];
    throw new Error(`예상하지 않은 단위 조회: ${sql}`);
  });
  const tx = {
    $queryRaw: query,
    world: {
      findUniqueOrThrow: vi.fn(async () => {
        expect(worldLocked).toBe(true);
        trace.push('world-read');
        return world;
      }),
      update: vi.fn(async () => ({ actionSequence: ++world.actionSequence })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    treaty: {
      findMany: vi.fn(async () => {
        expect(worldLocked).toBe(true);
        trace.push('treaty-read');
        return structuredClone(rows);
      }),
    },
    inputEvent: {
      findFirst: vi.fn(async () => {
        trace.push('input-read');
        return events.find((event) => event.status === 'PENDING') ?? null;
      }),
      updateMany: vi.fn(async ({ where, data }: Prisma.InputEventUpdateManyArgs) => {
        Object.assign(
          events.find((event) => event.id === where?.id)!,
          data,
        );
        return { count: 1 };
      }),
    },
    worldResult: { findUnique: vi.fn().mockResolvedValue({ endedTick: 500 }) },
    general: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    generalTurn: { findMany: vi.fn().mockResolvedValue([]) },
    nationTurn: { findMany: vi.fn().mockResolvedValue([]) },
    city: { findMany: vi.fn().mockResolvedValue([]) },
    nation: { findMany: vi.fn().mockResolvedValue([]) },
    diplomacy: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const transaction = vi.fn(async (run: (client: Prisma.TransactionClient) => Promise<unknown>) => {
    worldLocked = false;
    trace.push('transaction');
    return run(tx as unknown as Prisma.TransactionClient);
  });
  const db = { $transaction: transaction } as unknown as PrismaClient;
  const lease: Lease = { worldId: world.id, ownerId: 'owner', fencingToken: 9, ttlMs: 15000 };
  const loop = new TurnLoop(db, lease, { elapsedNow: () => 0, ...(beforeCommit ? { beforeCommit } : {}) });
  return {
    world,
    rows,
    events,
    trace,
    tx,
    transaction,
    loop,
    failFenceAt: (at: number) => {
      failFence = at;
    },
  };
}
function brokenClosed() {
  return {
    id: 1,
    fromNationId: 1,
    toNationId: 2,
    clauses: [{ kind: 'peace' }],
    status: 'ENDED',
    proposedTick: 0,
    respondByTick: 60000,
    startTick: 0,
    endTick: null,
    costFrom: 0,
    costTo: 0,
    closedSequence: null,
  };
}
function pending(kind = 'treaty.propose', id = 1n): Event {
  return {
    id,
    worldId: 'world',
    userId: 'actor',
    generalId: 1,
    kind,
    idempotencyKey: `${kind}:request`,
    status: 'PENDING',
    payload: { toNationId: 2, clauses: [{ kind: 'peace' }] },
    result: null,
    sequence: null,
    stepTick: null,
    createdAt: new Date(0),
  } as Event;
}

it.each(statuses)('%s의 off 잔여 행은 입력·sequence 전에 같은 잠금 TX에서 실패한다 (단위)', async (status) => {
  const f = fixture(status);
  f.rows.push(brokenClosed());
  await expect(f.loop.advanceTo(999)).rejects.toThrow('조약을 끈 월드');
  expect(f.trace).toEqual(['transaction', 'lease-lock', 'fence', 'world-lock', 'world-read', 'treaty-read']);
  expect(f.tx.inputEvent.findFirst).not.toHaveBeenCalled();
  expect(f.tx.world.update).not.toHaveBeenCalled();
  expect(f.tx.world.updateMany).not.toHaveBeenCalled();
  expect(f.loop.state).toBeNull();
});

it.each(statuses)('%s의 caps 닫힌 파손 행도 입력 전에 실패한다 (단위)', async (status) => {
  const f = fixture(status, true);
  f.rows.push(brokenClosed());
  await expect(f.loop.advanceTo(999)).rejects.toThrow('마감 기록');
  expect(f.tx.inputEvent.findFirst).not.toHaveBeenCalled();
  expect(f.tx.world.update).not.toHaveBeenCalled();
});

it.each(statuses)('%s의 origin 불일치도 입력 전에 실패한다 (단위)', async (status) => {
  const f = fixture(status, true);
  f.world.replayOrigin = null;
  await expect(f.loop.advanceTo(999)).rejects.toThrow('조약 저장 형식');
  expect(f.tx.treaty.findMany).not.toHaveBeenCalled();
  expect(f.tx.inputEvent.findFirst).not.toHaveBeenCalled();
});

it('통과 표시를 캐시하지 않아 같은 loop의 다음 step도 저장 행을 검사한다 (단위)', async () => {
  const f = fixture();
  expect(await f.loop.advanceTo(999)).toEqual([]);
  f.rows.push(brokenClosed());
  await expect(f.loop.advanceTo(999)).rejects.toThrow('조약을 끈 월드');
  expect(f.tx.treaty.findMany).toHaveBeenCalledTimes(2);
  expect(f.tx.inputEvent.findFirst).toHaveBeenCalledOnce();
  expect(f.trace.filter((entry) => entry === 'ext-read')).toHaveLength(1);
});

it('RUNNING 최소 unknown 입력은 뒤 입력·턴·월간·시계 쓰기에 앞서 실패한다 (단위)', async () => {
  const f = fixture('RUNNING');
  f.events.push(pending('unknown'), pending('general.create', 2n));
  await expect(f.loop.advanceTo(10000)).rejects.toThrow('처리할 수 없는 대기 입력');
  expect(f.tx.world.update).not.toHaveBeenCalled();
  expect(f.tx.world.updateMany).not.toHaveBeenCalled();
  expect(f.tx.general.findFirst).toHaveBeenCalledOnce();
  expect(f.events.every((event) => event.status === 'PENDING')).toBe(true);
});

it('RUNNING의 null 반환은 뒤 입력과 턴·월간을 막는다 (반환 연결 단위 stub)', async () => {
  const f = fixture('RUNNING');
  const process = vi.spyOn(inputs, 'processPendingInput').mockResolvedValueOnce(null);
  expect(await f.loop.advanceTo(10000)).toEqual([]);
  expect(process).toHaveBeenCalledExactlyOnceWith(expect.anything(), f.world, 10000, undefined);
  expect(f.tx.world.update).not.toHaveBeenCalled();
  expect(f.tx.world.updateMany).not.toHaveBeenCalled();
  expect(f.tx.general.findFirst).toHaveBeenCalledOnce();
  expect(f.transaction).toHaveBeenCalledOnce();
});

it('ENDED 조약은 잠근 clockTick으로 실제 Ops 처리기를 거쳐 한 번 배정한다 (단위)', async () => {
  const f = fixture('ENDED', true);
  f.events.push(pending());
  expect(await f.loop.advanceTo(999)).toEqual([]);
  expect(f.events[0]).toMatchObject({ sequence: 1, status: 'REJECTED', result: { tick: 600, code: 'WORLD_CLOSED' } });
  expect(f.tx.world.update).toHaveBeenCalledOnce();
  expect(f.tx.world.updateMany).not.toHaveBeenCalled();
  expect(f.transaction).toHaveBeenCalledTimes(2);
  expect(f.tx.treaty.findMany).toHaveBeenCalledTimes(2);
  expect(f.trace.filter((entry) => entry === 'fence')).toHaveLength(4);
});

it('초기 fence 실패는 gate와 입력을 실행하지 않는다 (단위)', async () => {
  const f = fixture();
  f.failFenceAt(1);
  await expect(f.loop.advanceTo(999)).rejects.toBeInstanceOf(LeaseLostError);
  expect(f.tx.treaty.findMany).not.toHaveBeenCalled();
  expect(f.tx.inputEvent.findFirst).not.toHaveBeenCalled();
});

it('마지막 fence 실패는 메모리 상태를 내보내지 않는다 (단위, DB 롤백 증거 아님)', async () => {
  const f = fixture('ENDED', true);
  f.events.push(pending());
  f.failFenceAt(2);
  await expect(f.loop.advanceTo(999)).rejects.toBeInstanceOf(LeaseLostError);
  expect(f.loop.state).toBeNull();
  expect(f.transaction).toHaveBeenCalledOnce();
});

it('beforeCommit 실패 뒤 재시도도 매 step 검사를 다시 지난다 (단위)', async () => {
  const hook = vi.fn().mockRejectedValueOnce(new Error('commit 전 실패'));
  const f = fixture('ENDED', true, hook);
  f.events.push(pending());
  await expect(f.loop.advanceTo(999)).rejects.toThrow('commit 전 실패');
  f.rows.push(brokenClosed());
  await expect(f.loop.advanceTo(999)).rejects.toThrow('마감 기록');
  expect(f.tx.treaty.findMany).toHaveBeenCalledTimes(2);
  expect(f.tx.inputEvent.findFirst).toHaveBeenCalledOnce();
  expect(f.loop.state).toBeNull();
});
