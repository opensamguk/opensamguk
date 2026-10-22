import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { acquireLease, lockLease } from '../apps/engine/src/lease';
import type { PrismaClient } from '../packages/db/src/index';
import { e2eDatabaseUrl } from './account';
import { removeWorlds } from './rankingCleanup';

// T2-23 · AC-M2-19 순위 E2E 정리. CI에서 e2e/rankingSeed.ts remove가 감독 엔진의 턴과 교착(40P01)해 P2034로
// 끝나고 순위 월드가 남은 일이 있었다. 엔진 턴은 EngineLease 행을 잠근 뒤 World 행을 잠근다. 월드 삭제는 World 행을
// 지운 뒤 cascade로 EngineLease 행을 지운다. 여기서는 실제 PostgreSQL 두 연결로 그 순서를 그대로 만든다.
// 앞의 넷은 DB 없이 다시 시도 규칙만 본다. 뒤의 넷은 E2E 전용 DB(_test)에서 실제 교착과 정리를 본다.

const execFileAsync = promisify(execFile);

function writeConflict(): Error {
  return Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2034',
  });
}

// deleteMany가 차례로 던지거나 돌려줄 값을 정해 둔 가짜 DB. 받은 인자와 기다린 시간을 남긴다.
function probe(results: Array<Error | number>, remaining = 0) {
  const calls: unknown[] = [];
  const counts: unknown[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const db = {
    world: {
      deleteMany: async (args: unknown) => {
        calls.push(structuredClone(args));
        const next = results.shift();
        if (next === undefined) throw new Error('예상보다 많이 불렸습니다.');
        if (next instanceof Error) throw next;
        return { count: next };
      },
      count: async (args: unknown) => {
        counts.push(structuredClone(args));
        return remaining;
      },
    },
  };
  const options = { sleep: async (ms: number) => void sleeps.push(ms), log: (line: string) => void logs.push(line) };
  return { db: db as never, options, calls, counts, sleeps, logs };
}

const ids = ['w-1', 'w-2'];
const where = { where: { id: { in: ['w-1', 'w-2'] } } };

test('P2034 한 번 뒤에는 100ms 기다려 같은 삭제를 다시 하고 남은 월드 0을 확인한다', async () => {
  const p = probe([writeConflict(), 2]);
  expect(await removeWorlds(p.db, ids, p.options)).toEqual({ removed: 2 });
  expect(p.calls).toEqual([where, where]);
  expect(p.sleeps).toEqual([100]);
  expect(p.counts).toEqual([where]);
  expect(p.logs).toHaveLength(1);
  expect(ids).toEqual(['w-1', 'w-2']);
});

test('P2034가 세 번이면 100ms·200ms 뒤 세 번째 오류를 그대로 던진다', async () => {
  const errors = [writeConflict(), writeConflict(), writeConflict()];
  const p = probe([...errors]);
  await expect(removeWorlds(p.db, ids, p.options)).rejects.toBe(errors[2]);
  expect(p.calls).toEqual([where, where, where]);
  expect(p.sleeps).toEqual([100, 200]);
  expect(p.counts).toEqual([]);
});

test('P2034가 아닌 오류는 다시 시도하지 않고 바로 던진다', async () => {
  const others = [
    Object.assign(new Error('Foreign key constraint violated'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2003',
    }),
    Object.assign(new Error('P2034처럼 보이는 일반 오류'), { code: 'P2034' }),
    new Error('connection terminated'),
  ];
  for (const error of others) {
    const p = probe([error, 2]);
    await expect(removeWorlds(p.db, ids, p.options)).rejects.toBe(error);
    expect(p.calls).toEqual([where]);
    expect(p.sleeps).toEqual([]);
    expect(p.counts).toEqual([]);
  }
});

test('지운 뒤에도 월드가 남아 있으면 성공으로 돌려주지 않는다', async () => {
  const p = probe([0], 1);
  await expect(removeWorlds(p.db, ids, p.options)).rejects.toThrow('월드 1개가 남았습니다');
});

test.describe('실제 PostgreSQL', () => {
  // 교착 감지는 PostgreSQL deadlock_timeout(기본 1초) 뒤에 일어나고 CLI는 tsx로 뜨는 데 몇 초 걸린다.
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  let db: PrismaClient;
  const made: string[] = [];

  test.beforeAll(async () => {
    const { createDb } = await import('../packages/db/src/index');
    db = createDb(e2eDatabaseUrl());
  });

  test.afterAll(async () => {
    if (!db) return;
    try {
      if (made.length > 0) await removeWorlds(db, made);
    } finally {
      await db.$disconnect();
    }
  });

  // PREOPEN 월드는 감독이 찾지 않으므로 이 시험 말고는 아무도 이 월드의 행을 잠그지 않는다.
  async function createWorld(): Promise<string> {
    const world = await db.world.create({
      data: {
        name: 'E2E 순위 정리',
        scenarioKey: 'e2e-cleanup',
        mapKey: 'e2e-cleanup',
        unitSetKey: 'e2e-cleanup',
        seed: randomUUID(),
        startYear: 190,
        turnTermMinutes: 60,
        initialStateHash: 'e2e-cleanup',
        statRules: {},
        unitSet: {},
        engineHeartbeat: { create: { at: new Date(), lastTick: 0, lagMs: 0 } },
      },
      select: { id: true },
    });
    made.push(world.id);
    return world.id;
  }

  // worldId를 가진 모든 표에서 이 ID들의 행 수. World 자신도 더한다.
  async function leftovers(worldIds: string[]): Promise<Record<string, number>> {
    const tables = await db.$queryRaw<{ table: string }[]>`SELECT table_name AS "table" FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'worldId' ORDER BY table_name`;
    expect(tables.map((t) => t.table)).toContain('EngineLease');
    const counts: Record<string, number> = {
      World: await db.world.count({ where: { id: { in: worldIds } } }),
    };
    for (const { table } of tables) {
      const [row] = await db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${table.replaceAll('"', '""')}" WHERE "worldId" = ANY($1::text[])`,
        worldIds,
      );
      counts[table] = row!.n;
    }
    return counts;
  }

  // 엔진 턴과 같은 순서로 잠근다. 리스를 잡고 한 트랜잭션에서 EngineLease 행을 잠근 채 삭제를 시작시킨다.
  // 삭제가 World 행을 쥔 채 이 연결의 EngineLease 잠금을 기다리는 것을 pg_blocking_pids로 확인한 뒤 World 행을 잠근다.
  // 먼저 기다리기 시작한 삭제가 deadlock_timeout 뒤 교착을 찾아 스스로 끊긴다. 이 연결이 World 잠금을 얻으면
  // 삭제가 끊겼다는 뜻이다. 반대로 이 연결이 끊기면 재현되지 않은 것이라 NOT_REPRODUCED로 실패한다.
  async function collide<T>(worldId: string, start: () => Promise<T>): Promise<PromiseSettledResult<T>> {
    const lease = await acquireLease(db, worldId, randomUUID(), 60_000);
    if (!lease) throw new Error('시험 월드의 리스를 얻지 못했습니다.');
    const seen: { outcome?: PromiseSettledResult<T> } = {};
    let started: Promise<void> | undefined;
    try {
      await db.$transaction(
        async (tx) => {
          await lockLease(tx, lease);
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          started = start().then(
            (value) => void (seen.outcome = { status: 'fulfilled', value }),
            (reason: unknown) => void (seen.outcome = { status: 'rejected', reason }),
          );
          for (let waited = 0; ; waited += 20) {
            const blocked = await db.$queryRaw<unknown[]>`SELECT pid FROM pg_stat_activity
              WHERE ${row!.pid}::int = ANY(pg_blocking_pids(pid)) AND query LIKE 'DELETE FROM "public"."World"%'`;
            if (blocked.length > 0) break;
            if (seen.outcome) throw new Error(`삭제가 이 연결을 기다리기 전에 끝났습니다: ${seen.outcome.status}`);
            if (waited > 20_000) throw new Error('삭제가 EngineLease 잠금을 기다리지 않았습니다.');
            await delay(20);
          }
          await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
        },
        { maxWait: 5_000, timeout: 40_000 },
      );
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'P2034') throw error;
      throw new Error(`NOT_REPRODUCED: 삭제가 아니라 잠금을 쥔 연결이 교착으로 끊겼습니다. ${String(error)}`, {
        cause: error,
      });
    }
    await started;
    return seen.outcome!;
  }

  function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
    return execFileAsync('pnpm', ['exec', 'tsx', '--env-file-if-exists=.env', 'e2e/rankingSeed.ts', ...args], {
      encoding: 'utf8',
      env,
    });
  }

  test('대조: 다시 시도 없는 원래 deleteMany는 P2034(40P01)로 끝나고 월드가 남는다', async () => {
    const worldIds = [await createWorld(), await createWorld()];
    const outcome = await collide(worldIds[0]!, () => db.world.deleteMany({ where: { id: { in: worldIds } } }));
    expect(outcome.status).toBe('rejected');
    const error = (outcome as PromiseRejectedResult).reason as {
      name: string;
      code: string;
      meta?: { driverAdapterError?: { cause?: { originalCode?: string; kind?: string } } };
    };
    expect(error.name).toBe('PrismaClientKnownRequestError');
    expect(error.code).toBe('P2034');
    expect(error.meta?.driverAdapterError?.cause).toMatchObject({
      originalCode: '40P01',
      kind: 'TransactionWriteConflict',
    });
    // 삭제 문 전체가 되돌려져 두 월드와 리스가 그대로 있다. 원래 CI에서 정리가 남긴 상태와 같다.
    expect(await db.world.count({ where: { id: { in: worldIds } } })).toBe(2);
    expect(await db.engineLease.count({ where: { worldId: worldIds[0]! } })).toBe(1);

    expect(await removeWorlds(db, worldIds)).toEqual({ removed: 2 });
    expect(Object.values(await leftovers(worldIds)).every((n) => n === 0)).toBe(true);
  });

  test('remove CLI는 같은 교착 뒤 다시 지워 자기 월드와 딸린 행을 모두 없애고 다른 월드는 남긴다', async () => {
    const bystander = await createWorld();
    const worldIds = [await createWorld(), await createWorld()];
    const others = (await db.world.findMany({ where: { id: { notIn: worldIds } }, select: { id: true } })).map(
      (w) => w.id,
    );
    expect(others).toContain(bystander);

    const outcome = await collide(worldIds[0]!, () => cli(['remove', ...worldIds]));
    expect(outcome.status).toBe('fulfilled');
    const { stdout, stderr } = (outcome as PromiseFulfilledResult<{ stdout: string; stderr: string }>).value;
    // 첫 삭제가 교착으로 끊겨 한 번 다시 지웠다. removed는 성공한 뒤 한 번만 찍힌다.
    expect(stderr.match(/쓰기 충돌\(P2034\)/g)).toHaveLength(1);
    expect(stderr).toContain('1회째');
    expect(stdout.trim().split('\n')).toEqual(['{"removed":2}']);

    const counts = await leftovers(worldIds);
    expect(counts).toMatchObject({ World: 0, EngineLease: 0, EngineHeartbeat: 0 });
    expect(Object.entries(counts).filter(([, n]) => n !== 0)).toEqual([]);
    expect(await db.world.count({ where: { id: { in: others } } })).toBe(others.length);

    // 이미 지운 ID와 빈 목록을 다시 넘겨도 안전하고 다른 월드는 그대로다.
    expect((await cli(['remove', ...worldIds])).stdout.trim()).toBe('{"removed":0}');
    expect((await cli(['remove'])).stdout.trim()).toBe('{"removed":0}');
    expect(await db.world.count({ where: { id: { in: others } } })).toBe(others.length);
  });

  test('remove CLI는 P2034가 아닌 DB 오류면 다시 시도하지 않고 0이 아닌 값으로 끝나며 removed를 찍지 않는다', async () => {
    const worldId = await createWorld();
    const url = new URL(e2eDatabaseUrl());
    url.pathname = `/${decodeURIComponent(url.pathname.slice(1))}_missing_${Date.now()}_test`;
    const failed = await cli(['remove', worldId], { ...process.env, DATABASE_URL: url.toString() }).then(
      () => null,
      (error: { code?: number; stdout?: string; stderr?: string }) => error,
    );
    expect(failed).not.toBeNull();
    expect(failed!.code).not.toBe(0);
    expect(failed!.stdout ?? '').not.toContain('removed');
    expect(failed!.stderr ?? '').not.toContain('P2034)로 되돌려졌습니다');
    // 다른 DB를 본 실패라 이 DB의 월드는 그대로다.
    expect(await db.world.count({ where: { id: worldId } })).toBe(1);
  });

  test('이 파일이 만든 월드는 모두 지워진다', async () => {
    expect(made.length).toBeGreaterThan(0);
    await removeWorlds(db, made);
    const counts = await leftovers(made);
    expect(Object.entries(counts).filter(([, n]) => n !== 0)).toEqual([]);
    made.length = 0;
  });
});
