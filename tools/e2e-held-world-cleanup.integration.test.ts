import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { acquireLease, LeaseLostError } from '../apps/engine/src/lease';
import { cleanupHeldWorld } from '../e2e/heldWorldCleanup';
import { testDatabaseUrl } from './test-database';

type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client: PgClient } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Client;
};
if (!process.env.TEST_DATABASE_URL) throw new Error('전용 시험 DB가 필요합니다.');
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(source.hostname)) throw new Error('loopback 시험 DB가 필요합니다.');
for (const key of source.searchParams.keys())
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    throw new Error('대상 변경 인자는 받지 않습니다.');
const name = `held_cleanup_${randomUUID().replaceAll('-', '')}_test`,
  target = new URL(source),
  root = new URL(source);
target.pathname = '/' + name;
root.pathname = '/postgres';
const admin = new PgClient({ connectionString: root.href }),
  blocker = new PgClient({ connectionString: target.href }),
  db = createDb(target.href);
const running = new Set<Promise<unknown>>(),
  errors: unknown[] = [],
  pools = new Set<ReturnType<typeof createDb>>();
function track<T>(work: () => Promise<T>) {
  const promise = Promise.resolve().then(work);
  running.add(promise);
  void promise.then(
    () => running.delete(promise),
    (error) => {
      errors.push(error);
      running.delete(promise);
    },
  );
  return promise;
}
async function settle() {
  while (running.size) await Promise.allSettled([...running]);
}
function it(title: string, work: () => Promise<void>) {
  test(title, () => track(work));
}
beforeEach(settle);
let created = false,
  oid: string,
  blockerPid: number;
let catalog: Record<string, unknown>[];
const getCatalog = async () =>
  (await admin.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows;
beforeAll(() =>
  track(async () => {
    await admin.connect();
    catalog = await getCatalog();
    expect(catalog.some((row) => row.datname === name)).toBe(false);
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    oid = String((await getCatalog()).find((row) => row.datname === name)!.oid);
    await blocker.connect();
    blockerPid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
    const directory = new URL('../packages/db/prisma/migrations/', import.meta.url);
    for (const migration of (await readdir(directory)).filter((value) => /^\d{14}_/.test(value)).sort())
      await blocker.query(await readFile(new URL(migration + '/migration.sql', directory), 'utf8'));
  }),
);
afterAll(async () => {
  await settle();
  try {
    await blocker.query('ROLLBACK');
  } catch (error) {
    errors.push(error);
  }
  for (const close of [
    () => blocker.end(),
    () => db.$disconnect(),
    ...[...pools].map((pool) => () => pool.$disconnect()),
  ])
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  let connections: number | undefined,
    dropped = false;
  try {
    if (created) {
      for (let i = 0; i <= 30; i++) {
        connections = Number(
          (await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]!
            .count,
        );
        if (connections === 0 || i === 30) break;
        await delay(100);
      }
      expect(connections).toBe(0);
      expect((await getCatalog()).find((row) => row.datname === name)).toEqual({ datname: name, oid });
      if (!errors.length) {
        await admin.query(`DROP DATABASE "${name}"`);
        dropped = true;
        expect(await getCatalog()).toEqual(catalog);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await admin.end();
  } catch (error) {
    errors.push(error);
  }
  console.info(JSON.stringify({ event: 'held-world-cleanup', name, oid, connections, dropped, errors: errors.length }));
  if (errors.length) throw new AggregateError(errors, '실행권 월드 정리 검사 실패');
});
async function world() {
  const initial = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'cleanup-formal',
  });
  initial.ruleFeatures = [
    'campaign-assignment-v2',
    'campaign-v1',
    'five-stats',
    'operational-map',
    'personnel',
    'policy',
    'stratagem-basic',
    'treaty',
  ];
  expect(initial.nations).toHaveLength(21);
  expect(initial.generals).toHaveLength(491);
  return (await saveInitialWorld(db, initial, { name: '정리 시험 월드', turnTermMinutes: 60, endYear: 201 })).worldId;
}
async function hold(worldId: string) {
  const own = createDb(target.href);
  pools.add(own);
  const lease = await acquireLease(own, worldId);
  expect(lease).not.toBeNull();
  return { db: own, lease: lease!, done: new AbortController(), renewal: Promise.resolve() };
}
async function snapshot(worldId: string) {
  const hash = createHash('sha256');
  for (const table of ['World', 'Nation', 'City', 'General', 'GeneralTurn', 'NationTurn']) {
    const key = table === 'World' ? 'id' : 'worldId';
    hash.update(
      JSON.stringify(
        (
          await blocker.query(
            `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "${key}"=$1 ORDER BY to_jsonb(t)::text`,
            [worldId],
          )
        ).rows,
      ),
    );
  }
  return hash.digest('hex');
}
async function blocked() {
  const pids = (
    await admin.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))",
      [name, blockerPid],
    )
  ).rows;
  return pids.map((row) => Number(row.pid));
}
async function rollback() {
  try {
    await blocker.query('ROLLBACK');
  } catch (error) {
    errors.push(error);
  }
}

it('실제 Lease 보유자가 World를 잠글 수 있으며 정리는 같은 순서로 자기 월드만 지운다', async () => {
  const mine = await world(),
    other = await world(),
    owned = await hold(mine),
    before = await snapshot(other);
  let pending: Promise<unknown> | undefined;
  await blocker.query('BEGIN');
  try {
    await blocker.query('SELECT "worldId" FROM "EngineLease" WHERE "worldId"=$1 FOR UPDATE', [mine]);
    pending = track(() => cleanupHeldWorld(owned, target.href));
    await expect.poll(async () => (await blocked()).length).toBe(1);
    const [pid] = await blocked();
    expect(pid).not.toBe(blockerPid);
    await blocker.query("SET LOCAL lock_timeout='1s'");
    expect((await blocker.query('SELECT id FROM "World" WHERE id=$1 FOR UPDATE', [mine])).rows).toEqual([{ id: mine }]);
    await blocker.query('COMMIT');
    await pending;
    expect(await db.world.count({ where: { id: mine } })).toBe(0);
    expect(await db.general.count({ where: { worldId: mine } })).toBe(0);
    expect(await db.generalTurn.count({ where: { worldId: mine } })).toBe(0);
    expect(await snapshot(other)).toBe(before);
  } finally {
    await rollback();
    if (pending) await Promise.allSettled([pending]);
  }
});

for (const invalid of ['owner', 'expired', 'world-wait'] as const)
  it(`${invalid} 실행권이면 실제 월드·장수·예약을 보존한다`, async () => {
    const mine = await world(),
      owned = await hold(mine),
      before = await snapshot(mine);
    let pending: Promise<unknown> | undefined;
    try {
      if (invalid === 'owner')
        await db.engineLease.update({ where: { worldId: mine }, data: { ownerId: randomUUID() } });
      else if (invalid === 'expired')
        await db.engineLease.update({ where: { worldId: mine }, data: { expiresAt: new Date(0) } });
      else {
        await db.$executeRaw`UPDATE "EngineLease" SET "expiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 second' WHERE "worldId"=${mine}`;
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM "World" WHERE id=$1 FOR UPDATE', [mine]);
        // 이 거부는 예상 결과로 정착시킨 뒤 추적한다.
        pending = track(async () => {
          await expect(cleanupHeldWorld(owned, target.href)).rejects.toMatchObject({
            errors: [expect.any(LeaseLostError)],
          });
        });
        await expect.poll(async () => (await blocked()).length).toBe(1);
        await expect
          .poll(
            async () =>
              (
                await db.$queryRaw<
                  Array<{ expired: boolean }>
                >`SELECT "expiresAt"<=(clock_timestamp() AT TIME ZONE 'UTC') AS expired FROM "EngineLease" WHERE "worldId"=${mine}`
              )[0]!.expired,
          )
          .toBe(true);
        await blocker.query('COMMIT');
        await pending;
      }
      if (invalid !== 'world-wait')
        await expect(cleanupHeldWorld(owned, target.href)).rejects.toMatchObject({
          errors: [expect.any(LeaseLostError)],
        });
      expect(await snapshot(mine)).toBe(before);
      expect(await db.general.count({ where: { worldId: mine } })).toBe(491);
      expect(await db.generalTurn.count({ where: { worldId: mine } })).toBe(491 * 30);
    } finally {
      await rollback();
      if (pending) await Promise.allSettled([pending]);
    }
  });
