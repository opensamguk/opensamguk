import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@opensamguk/db';

export const DISCOVERY_MS = 10_000;
export const CRASH_WINDOW_MS = 5 * 60_000;
export const CRASH_LIMIT = 5;
export const CRASH_MESSAGE =
  '엔진이 5분 안에 5회 종료되어 자동 재시작을 멈췄습니다. 원인을 확인한 뒤 감독을 다시 시작하세요.';
export type SupervisorEvent = {
  worldId?: string;
  kind: 'started' | 'retry' | 'halted' | 'removed' | 'discovery-error' | 'record-error';
  pid?: number;
  delayMs?: number;
};

export function restartDelay(crashes: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, crashes - 1)));
}

export function recentCrashes(crashes: number[], now: number): number[] {
  return crashes.filter((at) => at > now - CRASH_WINDOW_MS);
}

type ManagedWorld = {
  child?: ChildProcess;
  exited?: Promise<void>;
  stopping: boolean;
  crashes: number[];
  consecutive: number;
  restartAt: number;
  halted: boolean;
};

function spawnEngine(worldId: string): ChildProcess {
  // tsx의 watch 래퍼를 거치지 않아 감독이 실제 엔진 PID를 소유한다.
  return spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./index.ts', import.meta.url)), '--world', worldId],
    {
      env: process.env,
      stdio: 'ignore',
    },
  );
}

export async function runSupervisor(
  db: PrismaClient,
  options: {
    signal: AbortSignal;
    onEvent?: (event: SupervisorEvent) => void;
    spawnChild?: (worldId: string) => ChildProcess;
  },
): Promise<void> {
  const worlds = new Map<string, ManagedWorld>();
  const pending = new Set<Promise<void>>();
  const emit = (event: SupervisorEvent) => options.onEvent?.(event);
  const spawnChild = options.spawnChild ?? spawnEngine;
  const now = () => performance.now();

  function recordFailure(worldId: string, halted: boolean) {
    // 한 월드의 쓰기 실패를 다른 월드의 발견·재시작 경로에서 기다리지 않는다.
    const work = db
      .$transaction(
        async (tx) => {
          const world = await tx.world.findUnique({ where: { id: worldId }, select: { clockTick: true } });
          if (!world) return;
          const data = {
            at: new Date(),
            lastTick: world.clockTick,
            lagMs: 0,
            lastError: halted ? CRASH_MESSAGE : '엔진이 종료되어 재시작을 기다립니다.',
          };
          await tx.engineHeartbeat.upsert({
            where: { worldId },
            create: { worldId, ...data },
            update: { lastError: data.lastError },
          });
        },
        { timeout: 5000, maxWait: 5000 },
      )
      .catch(() => {
        emit({ worldId, kind: 'record-error' });
      });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }

  function start(worldId: string, state: ManagedWorld) {
    let child: ChildProcess;
    const startedAt = now();
    const failed = () => {
      delete state.child;
      if (state.stopping || options.signal.aborted) return;
      const at = now();
      state.crashes = recentCrashes(state.crashes, at);
      state.crashes.push(at);
      // 5분 이상 살아 있던 자식은 백오프 단계를 초기화한다.
      state.consecutive = at - startedAt >= CRASH_WINDOW_MS ? 1 : state.consecutive + 1;
      state.halted = state.crashes.length >= CRASH_LIMIT;
      const delayMs = restartDelay(state.consecutive);
      state.restartAt = at + delayMs;
      emit({ worldId, kind: state.halted ? 'halted' : 'retry', delayMs });
      recordFailure(worldId, state.halted);
    };
    try {
      child = spawnChild(worldId);
    } catch {
      failed();
      return;
    }
    state.child = child;
    state.exited = new Promise<void>((resolve) => {
      let finished = false;
      const finish = async (code?: number | null) => {
        if (finished) return;
        finished = true;
        if (code === 0) {
          try {
            const world = await db.world.findUnique({ where: { id: worldId }, select: { status: true } });
            if (world?.status === 'ENDED') {
              delete state.child;
              state.stopping = true;
              resolve();
              return;
            }
          } catch {
            /* DB 오류는 기존 재시작 경로에서 다룬다. */
          }
        }
        failed();
        resolve();
      };
      child.once('error', () => void finish());
      child.once('exit', (code) => void finish(code));
    });
    emit({ worldId, kind: 'started', ...(child.pid === undefined ? {} : { pid: child.pid }) });
  }

  async function stop(state: ManagedWorld) {
    state.stopping = true;
    const child = state.child;
    if (!child) return;
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      child.kill('SIGTERM');
      await state.exited;
    } finally {
      clearTimeout(force);
    }
  }

  let discoverAt = 0;
  try {
    while (!options.signal.aborted) {
      if (now() >= discoverAt) {
        discoverAt = now() + DISCOVERY_MS;
        try {
          const active = await db.world.findMany({
            where: {
              OR: [
                { status: { in: ['RUNNING', 'PAUSED'] } },
                {
                  status: 'ENDED',
                  inputEvents: {
                    some: {
                      kind: { in: ['general.create', 'general.setPolicy', 'general.active'] },
                      status: 'PENDING',
                    },
                  },
                },
              ],
            },
            select: { id: true },
            orderBy: { id: 'asc' },
          });
          if (options.signal.aborted) break;
          const ids = new Set(active.map((world) => world.id));
          for (const [worldId, state] of worlds) {
            if (ids.has(worldId)) continue;
            worlds.delete(worldId);
            const work = stop(state).then(() => emit({ worldId, kind: 'removed' }));
            pending.add(work);
            void work.finally(() => pending.delete(work));
          }
          for (const worldId of ids) {
            if (!worlds.has(worldId)) {
              worlds.set(worldId, { stopping: false, crashes: [], consecutive: 0, restartAt: 0, halted: false });
            }
          }
        } catch {
          emit({ kind: 'discovery-error' });
        }
      }
      for (const [worldId, state] of worlds) {
        if (!options.signal.aborted && !state.child && !state.halted && !state.stopping && now() >= state.restartAt)
          start(worldId, state);
      }
      try {
        await delay(100, undefined, { signal: options.signal });
      } catch {
        if (!options.signal.aborted) throw new Error('감독 대기가 실패했습니다.');
      }
    }
  } finally {
    await Promise.all([...worlds.values()].map(stop));
    await Promise.all(pending);
  }
}
