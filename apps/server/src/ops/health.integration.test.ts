import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb } from '@opensamguk/db';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line opensamguk/no-cross-package-relative -- 통합 시험에서 루트 Probe와 서버를 연결하는 단일 import다.
import { probeHealth } from '../../../../tools/monitor/uptimeProbe';
import { buildServer } from '../server';
import { countEngineHealth, ENGINE_STALE_AGE_MS, ENGINE_STALE_LAG_MS, readEngineHealth } from './health';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('전용 통합 시험 DB가 필요합니다.');
let parsedDatabase: URL;
try {
  parsedDatabase = new URL(databaseUrl);
} catch {
  throw new Error('전용 통합 시험 DB 주소 형식을 확인하세요.');
}
if (
  !['postgres:', 'postgresql:'].includes(parsedDatabase.protocol) ||
  !/^[a-z][a-z0-9_]*_test$/.test(parsedDatabase.pathname.slice(1))
)
  throw new Error('전용 통합 시험 DB 이름이 필요합니다.');

const ownName = `t311_health_${randomUUID().replaceAll('-', '')}_test`;
function checkedName() {
  if (!/^t311_health_[0-9a-f]{32}_test$/.test(ownName)) throw new Error('자체 시험 DB 이름을 확인하세요.');
  return ownName;
}
checkedName();
const ownUrl = new URL(parsedDatabase);
ownUrl.pathname = `/${ownName}`;
const adminUrl = new URL(parsedDatabase);
adminUrl.pathname = '/postgres';
const readerName = ownName.slice(0, -5);
const readerUrl = new URL(ownUrl);
readerUrl.searchParams.set('application_name', readerName);
const db = createDb(readerUrl.href);
const writer = createDb(ownUrl.href);
const observer = createDb(ownUrl.href);
const admin = new Client({ connectionString: adminUrl.href });
const migrator = new Client({ connectionString: ownUrl.href });
const ownedWorlds: string[] = [];
const TIMEOUT_MS = 10_000;
type Identity = { name: string; oid: string };
type Ownership = { phase: 'none' | 'creating' | 'ambiguous' | 'dropped' } | ({ phase: 'owned' } & Identity);
let ownership: Ownership = { phase: 'none' };
let identity: Identity | undefined;
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let baseUrl: URL | undefined;
let unavailable: Awaited<ReturnType<typeof buildServer>> | undefined;
let closed: ReturnType<typeof createDb> | undefined;
let beforeCatalog: Identity[] | undefined;
let adminAttempted = false;
let adminConnected = false;
let migratorOpen = false;
let setupStage = 'setup';
let setupPromise: Promise<void> | undefined;
let cleanupPromise: Promise<Error[]> | undefined;
let setupReportedCleanup = false;
let migrationCount = 0;
const clientErrors: Error[] = [];

// Raw driver messages, stacks, and causes can contain connection credentials.
function safeError(stage: string, error: unknown): Error {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const sqlState = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` (${code})` : '';
  const clean = new Error(`${stage}${sqlState}: ${ownName}`);
  if (error instanceof TypeError) clean.name = 'TypeError';
  else if (error instanceof RangeError) clean.name = 'RangeError';
  return clean;
}
admin.on('error', (error: Error) => clientErrors.push(safeError('admin event', error)));
migrator.on('error', (error: Error) => clientErrors.push(safeError('migration event', error)));

async function catalog(): Promise<Identity[]> {
  return (await admin.query<Identity>('SELECT datname AS name, oid::text AS oid FROM pg_database ORDER BY datname'))
    .rows;
}

async function setup() {
  setupStage = 'admin connect';
  adminAttempted = true;
  await admin.connect();
  adminConnected = true;
  setupStage = 'catalog before';
  beforeCatalog = await catalog();
  setupStage = 'create absence';
  const absent = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [ownName]);
  if (absent.rows.length !== 0) throw new Error('자체 시험 DB 이름이 이미 있습니다.');
  setupStage = 'create';
  const createName = checkedName();
  ownership = { phase: 'creating' };
  try {
    await admin.query(`CREATE DATABASE "${createName}"`);
    setupStage = 'created OID';
    const created = await admin.query<Identity>(
      'SELECT datname AS name, oid::text AS oid FROM pg_database WHERE datname = $1',
      [ownName],
    );
    const value = created.rows[0];
    if (created.rows.length !== 1 || !value || value.name !== ownName || !/^[0-9]+$/.test(value.oid))
      throw new Error('만든 시험 DB의 OID를 확인하지 못했습니다.');
    identity = value;
    ownership = { phase: 'owned', ...value };
  } catch (error) {
    ownership = { phase: 'ambiguous' };
    throw error;
  }
  setupStage = 'migration';
  const directory = new URL('../../../../packages/db/prisma/migrations/', import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => /^\d/.test(name)).sort();
  if (migrations.length !== 18 || migrations.at(-1) !== '20261023073000_treaties')
    throw new Error('준비한 migration 목록이 달라졌습니다.');
  migratorOpen = true;
  await migrator.connect();
  for (const name of migrations) {
    await migrator.query(await readFile(new URL(`${name}/migration.sql`, directory), 'utf8'));
    migrationCount += 1;
  }
  await migrator.end();
  migratorOpen = false;
  setupStage = 'reader identity';
  expect(await databaseIdentity()).toEqual(identity);
  const [reader] = await db.$queryRaw<Array<{ name: string }>>`SELECT current_setting('application_name') AS name`;
  expect(reader?.name).toBe(readerName);
  expect(await db.world.count()).toBe(0);
  await Promise.all([writer.$queryRaw`SELECT 1`, observer.$queryRaw`SELECT 1`]);
  setupStage = 'HTTP listen';
  app = await buildServer({
    db,
    publicOrigin: 'http://127.0.0.1:5173',
    now: () => 0,
    logging: false,
    realtime: { connectionString: ownUrl.href },
  });
  baseUrl = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
}

async function closeUnavailable(): Promise<Error[]> {
  const errors: Error[] = [];
  try {
    await unavailable?.close();
    unavailable = undefined;
  } catch (error) {
    errors.push(safeError('unavailable app close', error));
  }
  try {
    await closed?.$disconnect();
    closed = undefined;
  } catch (error) {
    errors.push(safeError('unavailable client close', error));
  }
  return errors;
}

async function runCleanup(): Promise<Error[]> {
  // A timed-out hook must not race its still-pending CREATE or migration.
  await setupPromise?.catch(() => undefined);
  const errors = await closeUnavailable();
  const steps: Array<{ stage: string; ok: boolean }> = [];
  async function step(stage: string, action: () => Promise<unknown>) {
    try {
      await action();
      steps.push({ stage, ok: true });
      return true;
    } catch (error) {
      errors.push(safeError(stage, error));
      steps.push({ stage, ok: false });
      return false;
    }
  }
  let resourcesClosed = errors.length === 0;
  for (const [stage, action] of [
    ['app close', async () => app?.close()],
    ['reader close', async () => db.$disconnect()],
    ['writer close', async () => writer.$disconnect()],
    ['observer close', async () => observer.$disconnect()],
    [
      'migration close',
      async () => {
        if (migratorOpen) {
          await migrator.end();
          migratorOpen = false;
        }
      },
    ],
  ] satisfies Array<[string, () => Promise<unknown>]>) {
    if (!(await step(stage, action))) resourcesClosed = false;
  }
  if (ownership.phase === 'owned') {
    const owned = ownership;
    await step('owned DB cleanup', async () => {
      if (!resourcesClosed) throw new Error('시험 자원을 닫지 못해 DB를 보존합니다.');
      let connections = -1;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const result = await admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid = $1::oid',
          [owned.oid],
        );
        connections = result.rows[0]?.n ?? -1;
        if (connections === 0) break;
        if (attempt < 49) await delay(100);
      }
      if (connections !== 0) throw new Error('연결이 남아 시험 DB를 보존합니다.');
      const result = await admin.query<Identity>(
        'SELECT datname AS name, oid::text AS oid FROM pg_database WHERE datname = $1',
        [owned.name],
      );
      if (result.rows.length !== 1 || result.rows[0]?.oid !== owned.oid)
        throw new Error('OID가 달라 시험 DB를 보존합니다.');
      const dropName = checkedName();
      await admin.query(`DROP DATABASE "${dropName}"`);
      ownership = { phase: 'dropped' };
      const absent = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1 OR oid = $2::oid', [
        owned.name,
        owned.oid,
      ]);
      if (absent.rows.length !== 0) throw new Error('시험 DB가 남았습니다.');
    });
  } else if (ownership.phase === 'creating' || ownership.phase === 'ambiguous') {
    errors.push(safeError('ambiguous DB preserved', undefined));
  }
  let additionalDatabases: number | undefined;
  if (adminConnected && beforeCatalog) {
    await step('catalog preservation', async () => {
      const after = await catalog();
      for (const previous of beforeCatalog!) {
        if (!after.some((value) => value.name === previous.name && value.oid === previous.oid))
          throw new Error('기존 DB 목록과 OID가 달라졌습니다.');
      }
      additionalDatabases = after.filter(
        (value) => !beforeCatalog!.some((previous) => previous.name === value.name && previous.oid === value.oid),
      ).length;
    });
  }
  if (adminAttempted) await step('admin close', async () => admin.end());
  errors.push(...clientErrors);
  process.stdout.write(
    `${JSON.stringify({ fixture: 't311-health', name: ownName, oid: identity?.oid ?? null, migrationCount, ownership: ownership.phase, steps, additionalDatabases, cleanupErrors: errors.length })}\n`,
  );
  return errors;
}

function cleanup(): Promise<Error[]> {
  cleanupPromise ??= runCleanup();
  return cleanupPromise;
}

function failSetup(error: unknown, errors: Error[]): never {
  const original = safeError(setupStage, error);
  if (errors.length === 0) throw original;
  throw new AggregateError([original, ...errors], '건강 통합 시험 준비에 실패했습니다.');
}

async function databaseIdentity() {
  const [value] = await db.$queryRaw<Array<{ name: string; oid: string }>>`
    SELECT datname AS name, oid::text AS oid FROM pg_database WHERE datname = current_database()`;
  if (!value || value.name !== ownName || value.oid !== identity?.oid)
    throw new Error('시험 DB 정체성을 확인하지 못했습니다.');
  return value;
}

async function dbNow(): Promise<Date> {
  const [value] = await db.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp() AS now`;
  expect(value?.now).toBeInstanceOf(Date);
  expect(Number.isFinite(value!.now.getTime())).toBe(true);
  return value!.now;
}

async function world(status: 'RUNNING' | 'PAUSED' | 'PREOPEN' | 'ENDED', heartbeat?: { at: Date; lagMs: number }) {
  const created = await db.world.create({
    data: {
      name: '건강 경로 통합 시험',
      scenarioKey: 'health-fixture',
      mapKey: 'health-fixture',
      unitSetKey: 'health-fixture',
      seed: 'health-fixture',
      startYear: 191,
      turnTermMinutes: 1,
      status,
      initialStateHash: 'health-fixture',
      statRules: {},
      unitSet: {},
    },
    select: { id: true },
  });
  ownedWorlds.push(created.id);
  if (heartbeat) await db.engineHeartbeat.create({ data: { worldId: created.id, lastTick: 0, ...heartbeat } });
  return created.id;
}

async function getHealth(target: URL, path: string, headers?: Record<string, string>) {
  const response = await fetch(new URL(path, target), {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...(headers ? { headers } : {}),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function expectHeaders(headers: Headers) {
  expect(headers.get('cache-control')).toBe('no-store');
  expect(headers.get('x-content-type-options')).toBe('nosniff');
  expect(headers.get('referrer-policy')).toBe('same-origin');
  expect(headers.get('x-frame-options')).toBe('DENY');
  expect(headers.get('set-cookie')).toBeNull();
  expect(headers.get('access-control-allow-origin')).toBeNull();
}

function localBase(): URL {
  if (!baseUrl) throw new Error('시험 HTTP 서버가 준비되지 않았습니다.');
  return baseUrl;
}

async function expectEngine(body: { ok: boolean; worlds: number; stale: number }) {
  const response = await getHealth(localBase(), '/healthz/engine');
  expect(response.status).toBe(body.ok ? 200 : 503);
  expect(response.body).toEqual(body);
  expectHeaders(response.headers);
  expect(await probeHealth({ baseUrl: localBase(), timeoutMs: TIMEOUT_MS })).toEqual({
    ok: body.ok,
    targets: [
      { path: '/healthz', outcome: 'ok', status: 200 },
      { path: '/healthz/engine', outcome: body.ok ? 'ok' : 'status', status: body.ok ? 200 : 503 },
    ],
  });
}

beforeAll(async () => {
  setupPromise = setup();
  try {
    await setupPromise;
  } catch (error) {
    const errors = await cleanup();
    setupReportedCleanup = true;
    failSetup(error, errors);
  }
});

afterEach(async () => {
  if (ownedWorlds.length === 0) return;
  expect(await databaseIdentity()).toEqual(identity);
  await db.world.deleteMany({ where: { id: { in: ownedWorlds } } });
  ownedWorlds.length = 0;
});

afterAll(async () => {
  const errors = await cleanup();
  if (!setupReportedCleanup && errors.length > 0)
    throw new AggregateError(errors, '건강 통합 시험 정리에 실패했습니다.');
});

describe('AC-M3-09 owned PostgreSQL and socket health evidence', () => {
  it('round-trips DB Dates and assesses the exact boundary against a frozen DB sample', async () => {
    const sampled = await dbNow();
    const id = await world('RUNNING', {
      at: new Date(sampled.getTime() - ENGINE_STALE_AGE_MS),
      lagMs: ENGINE_STALE_LAG_MS,
    });
    const rows = await db.world.findMany({
      where: { id },
      select: { engineHeartbeat: { select: { at: true, lagMs: true } } },
    });
    expect(rows[0]?.engineHeartbeat?.at).toBeInstanceOf(Date);
    expect(rows[0]?.engineHeartbeat?.at.getTime()).toBe(sampled.getTime() - ENGINE_STALE_AGE_MS);
    // No claim about a moving HTTP request landing on a one-millisecond boundary.
    expect(countEngineHealth(sampled.getTime(), rows)).toEqual({ worlds: 1, stale: 0 });
  });

  it('serves uncached socket HTTP and a successful Probe with no active worlds', async () => {
    const response = await getHealth(localBase(), '/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expectHeaders(response.headers);
    await expectEngine({ ok: true, worlds: 0, stale: 0 });
  });

  it('actually includes RUNNING and PAUSED while excluding PREOPEN and ENDED', async () => {
    const at = await dbNow();
    await world('RUNNING', { at, lagMs: 0 });
    await world('PAUSED', { at, lagMs: 0 });
    await world('PREOPEN');
    await world('ENDED');
    expect(await db.world.count()).toBe(4);
    await expectEngine({ ok: true, worlds: 2, stale: 0 });
    const response = await getHealth(localBase(), '/healthz/engine?worldId=ignored', {
      origin: 'https://outside.invalid',
      cookie: `sid=${'a'.repeat(64)}`,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, worlds: 2, stale: 0 });
    expectHeaders(response.headers);
  });

  it('reports a missing heartbeat through socket HTTP and Probe', async () => {
    await world('RUNNING');
    await world('PAUSED', { at: await dbNow(), lagMs: 0 });
    await expectEngine({ ok: false, worlds: 2, stale: 1 });
  });

  it('uses a clearly old DB-time fixture rather than the injected host clock', async () => {
    const sampled = await dbNow();
    await world('RUNNING', { at: new Date(sampled.getTime() - 10 * 60_000), lagMs: 0 });
    await expectEngine({ ok: false, worlds: 1, stale: 1 });
  });

  it('reports a clearly excessive lag without waiting for wall-clock expiry', async () => {
    await world('PAUSED', { at: await dbNow(), lagMs: ENGINE_STALE_LAG_MS + 60_000 });
    await expectEngine({ ok: false, worlds: 1, stale: 1 });
  });

  it('keeps world and heartbeat reads in the snapshot taken before a concurrent commit', async () => {
    const id = await world('RUNNING', { at: await dbNow(), lagMs: 0 });
    let reading: ReturnType<typeof readEngineHealth> | undefined;
    try {
      await writer.$transaction(async (tx) => {
        // All three clients and this table belong only to the dedicated fixture DB.
        await tx.$executeRaw`LOCK TABLE "World" IN ACCESS EXCLUSIVE MODE`;
        reading = readEngineHealth(db);
        const deadline = performance.now() + 2000;
        let waiting = false;
        while (performance.now() < deadline) {
          const [observed] = await observer.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_locks AS locks
              JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
              WHERE activity.datname = current_database()
                AND activity.application_name = ${readerName}
                AND NOT locks.granted
                AND locks.relation = '"World"'::regclass
            ) AS waiting`;
          if (observed?.waiting) {
            waiting = true;
            break;
          }
          await delay(20);
        }
        expect(waiting).toBe(true);
        await tx.world.update({ where: { id }, data: { status: 'PREOPEN' } });
        await tx.engineHeartbeat.update({ where: { worldId: id }, data: { lagMs: ENGINE_STALE_LAG_MS + 60_000 } });
      });
      expect(await reading).toEqual({ worlds: 1, stale: 0 });
      expect(await readEngineHealth(db)).toEqual({ worlds: 0, stale: 0 });
    } finally {
      // The writer transaction has committed or rolled back before awaiting this reader.
      await reading;
    }
  });

  it('serves 503 and a failed Probe for a closed DB port, without stopping PostgreSQL', async () => {
    closed = createDb('postgresql://unused@127.0.0.1:1/unused');
    let failure: unknown;
    let failed = false;
    let cleanupErrors: Error[];
    try {
      unavailable = await buildServer({ db: closed, publicOrigin: 'http://127.0.0.1:5173', logging: false });
      const target = new URL(await unavailable.listen({ host: '127.0.0.1', port: 0 }));
      const basic = await getHealth(target, '/healthz');
      expect(basic.status).toBe(503);
      expect(basic.body).toEqual({ ok: false });
      expectHeaders(basic.headers);
      const engine = await getHealth(target, '/healthz/engine');
      expect(engine.status).toBe(503);
      expect(engine.body).toEqual({ ok: false, worlds: null, stale: null });
      expectHeaders(engine.headers);
      expect(await probeHealth({ baseUrl: target, timeoutMs: TIMEOUT_MS })).toEqual({
        ok: false,
        targets: [
          { path: '/healthz', outcome: 'status', status: 503 },
          { path: '/healthz/engine', outcome: 'status', status: 503 },
        ],
      });
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      cleanupErrors = await closeUnavailable();
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        failed ? [failure, ...cleanupErrors] : cleanupErrors,
        '닫힌 포트 시험 정리에 실패했습니다.',
      );
    if (failed) throw failure;
  });
});
