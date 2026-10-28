import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeEach, expect, it as test } from 'vitest';
import { testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';

type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client: PgClient } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Client;
};
const cases = new Set<Promise<unknown>>(),
  caseErrors: unknown[] = [];
async function settleCases() {
  while (cases.size) await Promise.allSettled([...cases]);
}
beforeEach(settleCases);
afterAll(async () => {
  await settleCases();
  if (caseErrors.length) throw new AggregateError(caseErrors, 'DB 종료 시험 정착 실패');
});
function it(title: string, work: () => Promise<void>) {
  test(title, () => {
    const promise = Promise.resolve().then(work);
    cases.add(promise);
    void promise.then(
      () => cases.delete(promise),
      (error) => {
        caseErrors.push(error);
        cases.delete(promise);
      },
    );
    return promise;
  });
}
for (const mode of ['delayed', 'lingering', 'lingering-two', 'wrong-oid'] as const)
  it(`정상 종료 관측 ${mode}는 실제 연결과 자기 DB 식별자를 확인한다`, async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('전용 시험 DB가 필요합니다.');
    const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
    if (!['127.0.0.1', 'localhost'].includes(source.hostname)) throw new Error('loopback 시험 DB가 필요합니다.');
    for (const key of source.searchParams.keys())
      if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
        throw new Error('대상 변경 인자는 받지 않습니다.');
    const name = `db_close_${randomUUID().replaceAll('-', '')}_test`,
      target = new URL(source),
      root = new URL(source);
    target.pathname = '/' + name;
    root.pathname = '/postgres';
    const admin = new PgClient({ connectionString: root.href }),
      held = new PgClient({ connectionString: target.href }),
      second = new PgClient({ connectionString: target.href });
    let created = false,
      connected = false,
      secondConnected = false,
      passed = false,
      dropped = false,
      oid: string | undefined;
    const errors: unknown[] = [],
      running = new Set<Promise<unknown>>();
    let bodyError: unknown;
    const track = <T>(promise: Promise<T>) => {
      running.add(promise);
      void promise.then(
        () => running.delete(promise),
        (error) => {
          errors.push(error);
          running.delete(promise);
        },
      );
      return promise;
    };
    try {
      await admin.connect();
      expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      oid = String(
        (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows[0]!.oid,
      );
      await held.connect();
      connected = true;
      const heldPid = Number((await held.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
      const ownedPids = [heldPid];
      if (mode === 'lingering-two') {
        await second.connect();
        secondConnected = true;
        const secondPid = Number((await second.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
        expect(secondPid).not.toBe(heldPid);
        ownedPids.push(secondPid);
      }
      const assertOwnedPeers = async () => {
        for (const pid of ownedPids)
          expect(
            (
              await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND pid=$2', [
                name,
                pid,
              ])
            ).rows,
          ).toEqual([{ count: 1 }]);
        expect((await held.query('SELECT 1 AS live')).rows).toEqual([{ live: 1 }]);
        if (secondConnected) expect((await second.query('SELECT 1 AS live')).rows).toEqual([{ live: 1 }]);
      };
      await assertOwnedPeers();
      if (mode === 'delayed') {
        let release: Promise<void> | undefined;
        // 실제 첫 연결 관측 뒤 종료를 시작한다. SQL과 반환 행은 그대로 전달한다.
        const observed = {
          async query(sql: string, values?: unknown[]) {
            const result = await admin.query(sql, values);
            release ??= track(
              (async () => {
                await delay(300);
                await held.end();
                connected = false;
              })(),
            );
            return result;
          },
        };
        const result = await confirmDisconnectedDatabase(observed, name, oid);
        expect(release).toBeDefined();
        await release;
        expect(result.initialConnections).toBeGreaterThanOrEqual(1);
        expect(result.observations).toBeGreaterThan(0);
        expect(result.connections).toBe(0);
      } else if (mode === 'lingering' || mode === 'lingering-two') {
        await expect(confirmDisconnectedDatabase(admin, name, oid)).rejects.toThrow('연결이 남아');
        expect((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows).toEqual([
          { oid },
        ]);
        await assertOwnedPeers();
        const backendCounts = (
          await admin.query(
            'SELECT backend_type,count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 GROUP BY backend_type ORDER BY backend_type',
            [name],
          )
        ).rows;
        console.info(
          JSON.stringify({ event: 'db-close-owned-peers', mode, ownedPeers: ownedPids.length, backendCounts }),
        );
      } else {
        await held.end();
        connected = false;
        await expect(confirmDisconnectedDatabase(admin, name, String(BigInt(oid) + 1n))).rejects.toThrow(
          '식별자가 달라',
        );
        expect((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows).toEqual([
          { oid },
        ]);
      }
      passed = true;
    } catch (error) {
      bodyError = error;
    } finally {
      while (running.size) await Promise.allSettled([...running]);
      if (connected)
        try {
          await held.end();
        } catch (error) {
          errors.push(error);
        }
      if (secondConnected)
        try {
          await second.end();
        } catch (error) {
          errors.push(error);
        }
      try {
        if (created && passed && oid && !errors.length) {
          expect((await confirmDisconnectedDatabase(admin, name, oid)).connections).toBe(0);
          await admin.query(`DROP DATABASE "${name}"`);
          dropped = true;
          expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        await admin.end();
      } catch (error) {
        errors.push(error);
      }
      console.info(JSON.stringify({ event: 'db-close-observation', mode, passed, dropped, errors: errors.length }));
    }
    if (bodyError || errors.length)
      throw new AggregateError([...(bodyError ? [bodyError] : []), ...errors], 'DB 종료 관측 시험 실패');
  });
