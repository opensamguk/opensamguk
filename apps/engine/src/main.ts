import { setTimeout as delay, setImmediate as yieldImmediate } from 'node:timers/promises';
import type { PrismaClient } from '@opensamguk/db';
import {
  acquireLease,
  assertLease,
  databaseNow,
  LEASE_TTL_MS,
  LeaseLostError,
  lockLease,
  releaseLease,
  renewLease,
  type Lease,
} from './lease';
import { TurnLoop, type PollBatch } from './turnLoop';
import { engineMetricSink } from './metrics';

export const HEARTBEAT_MS = 30_000;

export async function writeHeartbeat(db: PrismaClient, lease: Lease, lagMs: number): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockLease(tx, lease);
    const world = await tx.world.findUniqueOrThrow({ where: { id: lease.worldId }, select: { clockTick: true } });
    const data = {
      at: await databaseNow(tx),
      lastTick: world.clockTick,
      lagMs: Math.min(2_147_483_647, Math.max(0, Math.floor(lagMs))),
      lastError: null,
    };
    await tx.engineHeartbeat.upsert({
      where: { worldId: lease.worldId },
      create: { worldId: lease.worldId, ...data },
      update: data,
    });
    await assertLease(tx, lease);
  });
}

export function engineFailureMessage(error: unknown): string {
  if (error instanceof LeaseLostError) return `[engine] ${error.name}: ${error.message}`;
  // 연결 문자열을 포함할 수 있는 원본 DB 오류는 노출하지 않는다.
  return '[engine] 실행 실패. 월드 ID·DB 연결·migration·실행권을 확인하세요.';
}

export async function runEngine(
  db: PrismaClient,
  options: {
    worldId?: string;
    signal: AbortSignal;
    onStatus?: (status: string) => void;
    onBatch?: (batch: PollBatch, timing: { startedAt: number; finishedAt: number }) => void;
  },
) {
  const { signal } = options;
  const commitMetricSink = engineMetricSink();
  let lastStatus: string | undefined;
  const report = (status: string) => {
    if (status !== lastStatus) options.onStatus?.(status);
    lastStatus = status;
  };
  const wait = async (ms: number) => {
    try {
      await delay(ms, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  };
  let worldId = options.worldId;
  while (!signal.aborted) {
    if (!worldId) {
      worldId = (
        await db.world.findFirst({ where: { status: 'RUNNING' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      )?.id;
      if (!worldId) {
        await wait(1000);
        continue;
      }
    }
    const lease = await acquireLease(db, worldId);
    if (!lease) {
      report('리스 대기');
      await wait(1000);
      continue;
    }
    report('실행권 획득');
    const loop = new TurnLoop(db, lease, commitMetricSink ? { commitMetricSink } : {});
    const session = new AbortController();
    const forwardAbort = () => session.abort(signal.reason);
    signal.addEventListener('abort', forwardAbort, { once: true });
    if (signal.aborted) forwardAbort();
    let renewalError: unknown;
    // setInterval의 겹친 갱신·미처리 rejection을 피한다.
    const renewal = (async () => {
      while (!session.signal.aborted) {
        try {
          await delay(LEASE_TTL_MS / 3, undefined, { signal: session.signal });
        } catch {
          break;
        }
        if (session.signal.aborted) break;
        try {
          await renewLease(db, lease);
        } catch (error) {
          renewalError = error;
          session.abort();
        }
      }
    })();
    let heartbeatError: unknown;
    const heartbeat = (async () => {
      let due = performance.now();
      try {
        while (!session.signal.aborted) {
          await writeHeartbeat(db, lease, performance.now() - due);
          due = performance.now() + HEARTBEAT_MS;
          await delay(HEARTBEAT_MS, undefined, { signal: session.signal });
        }
      } catch (error) {
        if (!session.signal.aborted) {
          heartbeatError = error;
          session.abort();
        }
      }
    })();
    try {
      let ended = false;
      while (!session.signal.aborted) {
        const startedAt = performance.now();
        const batch = await loop.poll(session.signal);
        options.onBatch?.(batch, { startedAt, finishedAt: performance.now() });
        if (batch.status === 'ENDED' && !batch.more) {
          ended = true;
          break;
        }
        try {
          if (batch.more) await yieldImmediate(undefined, { signal: session.signal });
          else await delay(100, undefined, { signal: session.signal });
        } catch {
          break;
        }
      }
      if (renewalError) throw renewalError;
      if (heartbeatError) throw heartbeatError;
      if (ended && !options.worldId) {
        worldId = undefined;
        continue;
      }
      return;
    } catch (error) {
      if (!signal.aborted) throw error;
      return;
    } finally {
      session.abort();
      signal.removeEventListener('abort', forwardAbort);
      await renewal;
      await heartbeat;
      await releaseLease(db, lease);
      report('실행권 해제');
    }
  }
}
