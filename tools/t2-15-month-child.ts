import { pathToFileURL } from 'node:url';
import { posix, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLease, LEASE_TTL_MS, LeaseLostError, releaseLease, renewLease } from '../apps/engine/src/lease';
import { onShutdownRequest } from '../apps/engine/src/process-lifecycle';

export function rehearsalStoragePath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? /^[eE]:[\\/]/.test(value) && win32.isAbsolute(value) : posix.isAbsolute(value);
}

export type RehearsalStageRecord = {
  name: string;
  status: 'passed' | 'failed';
  elapsedMs: number;
  reason?: string;
};

// B1의 자기 기한은 vitest hook·case의 30초보다 짧다. 늦은 작업도 정리까지 소유한다.
export function createRehearsalStages(
  controller: AbortController,
  record: (row: RehearsalStageRecord) => void,
  options: { budgetMs?: number; now?: () => number; reasonOf?: (error: unknown) => string } = {},
) {
  const budgetMs = options.budgetMs ?? 20_000;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 20_000) throw new Error('stage-budget');
  const now = options.now ?? (() => performance.now());
  const active = new Set<Promise<void>>();
  let failure: string | undefined;
  const reportFailure = (name: string, started: number) => {
    record({ name, status: 'failed', reason: failure!, elapsedMs: Math.max(0, now() - started) });
    return new Error(failure);
  };
  return {
    get activeCount() {
      return active.size;
    },
    get failure() {
      return failure;
    },
    async run(name: string, action: () => Promise<void>) {
      const started = now();
      if (failure) throw reportFailure(name, started);
      if (controller.signal.aborted) failure = 'aborted';
      else if (active.size) failure = 'previous-stage-active';
      if (failure) {
        controller.abort();
        throw reportFailure(name, started);
      }
      const operation = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        await action();
        controller.signal.throwIfAborted();
      });
      active.add(operation);
      // 두 결과를 모두 처리해 기한 뒤 reject도 미처리 promise로 버려 두지 않는다.
      void operation.then(
        () => active.delete(operation),
        () => active.delete(operation),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let aborted: (() => void) | undefined;
      const stopped = new Promise<never>((_, reject) => {
        aborted = () => {
          failure ??= 'aborted';
          reject(new Error(failure));
        };
        controller.signal.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => {
          failure ??= 'stage-deadline';
          controller.abort();
        }, budgetMs);
      });
      try {
        await Promise.race([operation, stopped]);
        if (now() - started >= budgetMs) {
          failure ??= 'stage-deadline';
          controller.abort();
          throw new Error(failure);
        }
        if (failure || controller.signal.aborted) {
          failure ??= 'aborted';
          throw new Error(failure);
        }
        record({ name, status: 'passed', elapsedMs: Math.max(0, now() - started) });
      } catch (error) {
        failure ??= options.reasonOf?.(error) ?? 'operation-failed';
        controller.abort();
        throw reportFailure(name, started);
      } finally {
        clearTimeout(timer);
        if (aborted) controller.signal.removeEventListener('abort', aborted);
      }
    },
    async settle() {
      controller.abort();
      await Promise.allSettled([...active]);
    },
  };
}

// T2-15/AC-M2-09: 시험 부모와 month 자식이 같은 리스 수명주기를 쓴다.
export async function advanceWithLease(
  databaseUrl: string,
  worldId: string,
  target: number,
  signal: AbortSignal,
): Promise<{ renewals: number; reached: number }> {
  const endpoint = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(endpoint.protocol) ||
    !['127.0.0.1', 'localhost'].includes(endpoint.hostname) ||
    (endpoint.port || '5432') === '5433' ||
    !/^t215_(?:src|dst)_[0-9a-f]{32}_test$/.test(endpoint.pathname.slice(1))
  )
    throw new Error('database');
  const [{ createDb }, { TurnLoop }] = await Promise.all([
    import('../packages/db/src/index'),
    import('../apps/engine/src/turnLoop'),
  ]);
  const db = createDb(databaseUrl);
  const session = new AbortController();
  const abort = () => session.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let lease: Awaited<ReturnType<typeof acquireLease>> = null;
  let renewal: Promise<void> | undefined;
  let renewalError: unknown;
  let renewals = 0;
  try {
    session.signal.throwIfAborted();
    lease = await acquireLease(db, worldId);
    if (!lease) throw new LeaseLostError();
    await renewLease(db, lease);
    renewals++;
    const owned = lease;
    renewal = (async () => {
      while (!session.signal.aborted) {
        try {
          await delay(LEASE_TTL_MS / 3, undefined, { signal: session.signal });
        } catch {
          break;
        }
        if (session.signal.aborted) break;
        try {
          await renewLease(db, owned);
          renewals++;
        } catch (error) {
          renewalError = error;
          session.abort();
        }
      }
    })();
    await new TurnLoop(db, lease).advanceTo(target, session.signal);
    if (renewalError) throw renewalError;
    session.signal.throwIfAborted();
    session.abort();
    await renewal;
    if (renewalError) throw renewalError;
    signal.throwIfAborted();
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId }, select: { monthlyTick: true } });
    if (world.monthlyTick !== target) throw new Error('boundary');
    return { renewals, reached: world.monthlyTick };
  } finally {
    session.abort();
    await renewal;
    signal.removeEventListener('abort', abort);
    try {
      if (lease) await releaseLease(db, lease);
    } finally {
      await db.$disconnect();
    }
  }
}

async function main() {
  const abort = new AbortController();
  const off = onShutdownRequest(() => abort.abort());
  let status: string;
  try {
    const [worldId, boundary, ...extra] = process.argv.slice(2);
    const target = Number(boundary);
    if (!worldId || !boundary || extra.length || !Number.isSafeInteger(target) || target < 1) throw new Error('input');
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      (url.port || '5432') === '5433' ||
      !/^t215_dst_[0-9a-f]{32}_test$/.test(url.pathname.slice(1))
    )
      throw new Error('database');
    await advanceWithLease(url.href, worldId, target, abort.signal);
    status = 'ok';
  } catch (error) {
    status = error instanceof LeaseLostError ? 'lease-lost' : abort.signal.aborted ? 'aborted' : 'failed';
  } finally {
    off();
  }
  console.log(status);
  if (status !== 'ok') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
