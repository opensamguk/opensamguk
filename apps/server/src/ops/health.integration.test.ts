import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb } from '@opensamguk/db';
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

const readerName = `t311_health_${randomUUID().replaceAll('-', '')}`;
const readerUrl = new URL(databaseUrl);
readerUrl.searchParams.set('application_name', readerName);
const db = createDb(readerUrl.href);
const writer = createDb(databaseUrl);
const observer = createDb(databaseUrl);
const ownedWorlds: string[] = [];
const TIMEOUT_MS = 10_000;
let identity: { name: string; oid: string } | undefined;
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let baseUrl: URL | undefined;

async function databaseIdentity() {
  const [value] = await db.$queryRaw<Array<{ name: string; oid: string }>>`
    SELECT datname AS name, oid::text AS oid FROM pg_database WHERE datname = current_database()`;
  if (!value || value.name !== parsedDatabase.pathname.slice(1))
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
  identity = await databaseIdentity();
  const [reader] = await db.$queryRaw<Array<{ name: string }>>`SELECT current_setting('application_name') AS name`;
  expect(reader?.name).toBe(readerName);
  // Aggregate endpoints count every active world, so this file requires an empty fixture DB.
  expect(await db.world.count()).toBe(0);
  await Promise.all([writer.$queryRaw`SELECT 1`, observer.$queryRaw`SELECT 1`]);
  app = await buildServer({ db, publicOrigin: 'http://127.0.0.1:5173', now: () => 0, logging: false });
  baseUrl = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
});

afterEach(async () => {
  if (ownedWorlds.length === 0) return;
  expect(await databaseIdentity()).toEqual(identity);
  await db.world.deleteMany({ where: { id: { in: ownedWorlds } } });
  ownedWorlds.length = 0;
});

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    await Promise.all([db.$disconnect(), writer.$disconnect(), observer.$disconnect()]);
  }
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
    const closed = createDb('postgresql://unused@127.0.0.1:1/unused');
    let unavailable: Awaited<ReturnType<typeof buildServer>> | undefined;
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
    } finally {
      try {
        await unavailable?.close();
      } finally {
        await closed.$disconnect();
      }
    }
  });
});
