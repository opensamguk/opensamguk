import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type PrismaClient } from '../packages/db/src/index';
import { toGameDate } from '../packages/rules/src/index';
import { buildServer } from '../apps/server/src/server';
import { authzCase } from '../apps/server/src/authz/case';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import type { AppRouter } from '../apps/server/src/router';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease, renewLease, type Lease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { pnpmCli } from './node-cli';
import { testDatabaseUrl } from './test-database';

// AC-M2-06·14: 실제 Fastify 주입, 세션, PostgreSQL, 중앙 엔진을 함께 지난다.
type TreatyCaller = ReturnType<AppRouter['createCaller']>['treaty'];
type Output = { [K in keyof TreatyCaller]: Awaited<ReturnType<TreatyCaller[K]>> };
type Path = 'treaty.break' | 'treaty.tradeTargets' | 'treaty.trust';
type QueuedPath = 'treaty.propose' | 'treaty.respond' | 'treaty.break';
type Wire = { status: number; data: unknown; error?: { data: { code: string; reason: unknown } } | undefined };
type Catalog = Array<{ name: string; oid: number }>;
type Fixture = {
  worldId: string;
  users: string[];
  cookies: string[];
  treatyId: string;
  lease?: Lease;
  loop?: TurnLoop;
};
const root = fileURLToPath(new URL('../', import.meta.url));
const migrationRoot = new URL('../packages/db/prisma/migrations/', import.meta.url);
const databaseName = `t207_authz_${randomUUID().replaceAll('-', '')}_test`;
const now = Date.now();
const origin = 'http://t207-authz.test';
const features = ['treaty', 'treaty-break', 'treaty-trade'];
let admin: PrismaClient | undefined;
let db: PrismaClient;
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let catalogBefore: Catalog | undefined;
let created = false;
let ownOid: number | undefined;
let passwordHash: string;
let stopMigration: (() => Promise<void>) | undefined;
let f: Fixture;
const fixtures: Fixture[] = [];
const pendingRequests = new Set<Promise<Wire>>();
const lifecycle = {
  database: databaseName,
  sourceAccess: 'URL_TEMPLATE_ONLY',
  migrations: 0,
  normalDrop: false,
  catalogIdentityPreserved: false,
};
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? String(v) : v)))
    .digest('hex');
async function catalog(): Promise<Catalog> {
  return admin!.$queryRaw<Catalog>`SELECT datname AS name, oid::int AS oid FROM pg_database ORDER BY datname`;
}
async function identity() {
  const rows = await admin!.$queryRaw<
    Array<{ oid: number }>
  >`SELECT oid::int AS oid FROM pg_database WHERE datname = ${databaseName}`;
  return rows[0]?.oid;
}
async function migrate(url: string) {
  const names = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expected = await Promise.all(
    names.map(async (name) => ({
      name,
      checksum: createHash('sha256')
        .update(await readFile(new URL(`${name}/migration.sql`, migrationRoot)))
        .digest('hex'),
      finished: true,
      rolledBack: false,
    })),
  );
  const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url };
  for (const candidate of [env.DATABASE_URL, env.TEST_DATABASE_URL])
    if (new URL(candidate).pathname !== `/${databaseName}`) throw Error('Migration 대상이 소유 DB와 다릅니다.');
  const abort = new AbortController();
  const child = spawn(...pnpmCli(['--filter', '@opensamguk/db', 'migrate'], env), {
    cwd: root,
    env,
    stdio: 'ignore',
    windowsHide: true,
    signal: abort.signal,
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  stopMigration = async () => {
    if (child.exitCode === null && !child.killed) abort.abort();
    await closed;
  };
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(Error('시험 migration 명령을 시작하지 못했습니다.')));
    child.once('close', resolve);
  });
  await closed;
  stopMigration = undefined;
  if (code !== 0) throw Error('조약 권한 시험 migration이 실패했습니다.');
  const actual = await db.$queryRaw<
    Array<{ name: string; checksum: string; finished: boolean; rolledBack: boolean }>
  >`SELECT migration_name AS name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack" FROM _prisma_migrations ORDER BY migration_name`;
  expect(actual).toEqual(expected);
  lifecycle.migrations = actual.length;
}
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw Error('전용 TEST_DATABASE_URL이 필요합니다.');
  const reference = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  const maintenance = new URL(reference);
  maintenance.pathname = '/postgres';
  const own = new URL(reference);
  own.pathname = `/${databaseName}`;
  testDatabaseUrl({ TEST_DATABASE_URL: own.href, DATABASE_URL: process.env.DATABASE_URL });
  admin = createDb(maintenance.href);
  catalogBefore = await catalog();
  if ((await identity()) !== undefined) throw Error('새 시험 DB 이름이 이미 있습니다.');
  await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
  created = true;
  ownOid = await identity();
  if (ownOid === undefined) throw Error('생성한 시험 DB의 OID가 없습니다.');
  db = createDb(own.href);
  const [connected] = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  expect(connected?.name).toBe(databaseName);
  await migrate(own.href);
  passwordHash = await hashPassword(randomUUID());
  app = await buildServer({ db, publicOrigin: origin, now: () => now, logging: false });
  await app.ready();
});

async function fixture(): Promise<Fixture> {
  const state = await monthlyFixture();
  const users = Array.from({ length: 6 }, () => randomUUID());
  const owned: Fixture = { worldId: '', users, cookies: [], treatyId: '' };
  fixtures.push(owned);
  await db.user.createMany({
    data: users.map((id, index) => ({
      id,
      email: `${id}@example.invalid`,
      passwordHash,
      status: index === 2 ? 'SANCTIONED' : 'ACTIVE',
    })),
  });
  for (const userId of users) {
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId, expiresAt: session.expiresAt } });
    owned.cookies.push(`sid=${session.token}`);
  }
  // 세 국가와 군주·일반 장수·제재 계정, 가입하지 않은 계정을 구분한다.
  state.nations = [1, 2, 3].map((id) => ({
    ...state.nations[0]!,
    id,
    name: `국가${id}`,
    color: ['#ff0000', '#0000ff', '#00ff00'][id - 1]!,
    capitalCityKey: id,
    isNpc: false,
    gold: 100000,
    rice: 100000,
  }));
  state.cities = state.cities.map((city, index) => ({ ...city, nationId: [1, 2, 3, 2][index]!, supplied: true }));
  const roles = [
    { user: 0, nation: 1 },
    { user: 1, nation: 3 },
    { user: 2, nation: 1 },
    { user: 3, nation: 1 },
    { user: 5, nation: 2 },
  ];
  state.generals = roles.map((role, index) => ({
    ...state.generals[0]!,
    id: index + 1,
    userId: users[role.user]!,
    nationId: role.nation,
    cityKey: role.nation,
    officerLevel: role.user === 3 ? 1 : 12,
    nextTurnTick: 10000,
  }));
  state.diplomacies = [];
  const made = await saveInitialWorld(db, state, {
    name: '조약 권한 HTTP 시험',
    turnTermMinutes: 120,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: features,
  });
  owned.worldId = made.worldId;
  const stored = await db.world.findUniqueOrThrow({ where: { id: made.worldId } });
  expect(stored.replayFormat).toBe(3);
  expect(stored.ruleFeatures).toEqual(features);
  await controlClock(db, made.worldId, 'start');
  return owned;
}
beforeEach(async () => {
  f = await fixture();
  const proposed = await complete('treaty.propose', { toNationId: 2, clauses: [{ kind: 'trade', months: 12 }] });
  if (proposed.status !== 'applied') throw Error('실제 HTTP 제안 fixture 실패');
  f.treatyId = proposed.treatyId;
  const accepted = await complete('treaty.respond', { treatyId: f.treatyId, accept: true }, 5);
  expect(accepted).toMatchObject({ status: 'applied', outcome: 'ACCEPTED', treatyId: f.treatyId });
});
afterEach(async () => {
  await Promise.allSettled([...pendingRequests]);
  for (const owned of fixtures.splice(0)) {
    if (owned.lease) await releaseLease(db, owned.lease);
    if (owned.worldId) await db.world.deleteMany({ where: { id: owned.worldId } });
    await db.user.deleteMany({ where: { id: { in: owned.users } } });
  }
});
afterAll(async () => {
  const errors: string[] = [];
  const attempt = async (stage: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch {
      errors.push(stage);
    }
  };
  await attempt('HTTP_CLOSE', async () => app?.close());
  await attempt('MIGRATION_CHILD_CLOSE', async () => stopMigration?.());
  await attempt('OWN_POOL_CLOSE', async () => db?.$disconnect());
  if (admin) {
    if (created && ownOid !== undefined)
      await attempt('OWN_NORMAL_DROP', async () => {
        expect(await identity()).toBe(ownOid);
        const rows = await admin!.$queryRaw<
          Array<{ count: number }>
        >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = ${databaseName}`;
        expect(rows[0]?.count).toBe(0);
        await admin!.$executeRawUnsafe(`DROP DATABASE "${databaseName}"`);
        expect(await identity()).toBeUndefined();
        const after = await admin!.$queryRaw<
          Array<{ count: number }>
        >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = ${databaseName}`;
        expect(after[0]?.count).toBe(0);
        lifecycle.normalDrop = true;
      });
    if (created && ownOid === undefined) errors.push('CREATED_OID_UNAVAILABLE_NO_DROP');
    if (catalogBefore)
      await attempt('CATALOG_IDENTITY', async () => {
        expect(digest(await catalog())).toBe(digest(catalogBefore));
        lifecycle.catalogIdentityPreserved = true;
      });
    await attempt('ADMIN_POOL_CLOSE', async () => admin!.$disconnect());
  }
  console.info('T2-07 authz lifecycle', { ...lifecycle, cleanupErrors: errors });
  if (errors.length) throw Error(`조약 권한 시험 정리 실패: ${errors.join(', ')}`);
});

async function wire(path: string, input: unknown, cookie?: string): Promise<Wire> {
  const mutation = path === 'treaty.propose' || path === 'treaty.respond' || path === 'treaty.break';
  const encoded = JSON.stringify({ 0: input });
  const response = await app!.inject({
    method: mutation ? 'POST' : 'GET',
    url: `/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
    ...(mutation ? { payload: encoded } : {}),
  });
  const body = response.json<Array<{ result?: { data: unknown }; error?: Wire['error'] }>>()[0];
  if (!body) throw Error('HTTP 응답 형식이 없습니다.');
  return { status: response.statusCode, data: body.result?.data, error: body.error };
}
function call(path: string, input: Record<string, unknown> = {}, user = 0, owned = f) {
  return wire(path, { worldId: owned.worldId, ...input }, owned.cookies[user]);
}
function value<T>(response: Wire): T {
  expect(response.status).toBe(200);
  expect(response.error).toBeUndefined();
  return response.data as T;
}
function error(response: Wire, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.error?.data.code).toBe(code);
  expect(response.error?.data.reason).toBeNull();
}
async function complete(path: QueuedPath, payload: Record<string, unknown>, user = 0): Promise<Output['request']> {
  const requestId = randomUUID();
  const response = call(path, { ...payload, requestId }, user);
  pendingRequests.add(response);
  void response.then(
    () => pendingRequests.delete(response),
    () => pendingRequests.delete(response),
  );
  const deadline = performance.now() + 4500;
  let queued = false;
  while (performance.now() < deadline) {
    const event = await db.inputEvent.findFirst({
      where: { worldId: f.worldId, userId: f.users[user]!, idempotencyKey: `${path}:${requestId}` },
    });
    if (event) {
      expect(event.status).toBe('PENDING');
      expect(event.sequence).toBeNull();
      queued = true;
      break;
    }
    await delay(10);
  }
  if (!queued) {
    const result = await response;
    throw Error(`실제 입력 접수 실패: HTTP ${result.status} ${result.error?.data.code ?? 'NO_ERROR'}`);
  }
  if (!f.lease) {
    const lease = await acquireLease(db, f.worldId);
    if (!lease) throw Error('시험 엔진 리스가 없습니다.');
    f.lease = lease;
    f.loop = new TurnLoop(db, lease);
  } else await renewLease(db, f.lease);
  expect((await f.loop!.poll()).executions).toEqual([]);
  const result = value<Output['request']>(await response);
  expect(result.status).not.toBe('pending');
  const stored = await db.inputEvent.findFirstOrThrow({
    where: { worldId: f.worldId, idempotencyKey: `${path}:${requestId}` },
  });
  expect(stored.status).toBe(result.status === 'applied' ? 'APPLIED' : 'REJECTED');
  return result;
}

async function snapshot() {
  // 소유 DB의 관련 쓰기 대상을 모두 해시로 비교해 실패 출력에 비밀값을 남기지 않는다.
  return digest(
    await Promise.all([
      db.user.findMany({ orderBy: { id: 'asc' } }),
      db.session.findMany({ orderBy: { id: 'asc' } }),
      db.world.findMany({ orderBy: { id: 'asc' } }),
      db.general.findMany({ orderBy: [{ worldId: 'asc' }, { id: 'asc' }] }),
      db.nation.findMany({ orderBy: [{ worldId: 'asc' }, { id: 'asc' }] }),
      db.city.findMany({ orderBy: [{ worldId: 'asc' }, { cityKey: 'asc' }] }),
      db.treaty.findMany({ orderBy: [{ worldId: 'asc' }, { id: 'asc' }] }),
      db.nationTrust.findMany({ orderBy: [{ worldId: 'asc' }, { nationId: 'asc' }] }),
      db.diplomacy.findMany({ orderBy: [{ worldId: 'asc' }, { nationA: 'asc' }, { nationB: 'asc' }] }),
      db.message.findMany({ orderBy: { id: 'asc' } }),
      db.inputEvent.findMany({ orderBy: { id: 'asc' } }),
      db.generalTurn.findMany({ orderBy: [{ worldId: 'asc' }, { generalId: 'asc' }, { slot: 'asc' }] }),
      db.nationTurn.findMany({ orderBy: [{ worldId: 'asc' }, { nationId: 'asc' }, { slot: 'asc' }] }),
      db.engineLease.findMany({ orderBy: { worldId: 'asc' } }),
      db.engineHeartbeat.findMany({ orderBy: { worldId: 'asc' } }),
    ]),
  );
}
function input(path: Path): Record<string, unknown> {
  return path === 'treaty.break' ? { requestId: randomUUID(), treatyId: f.treatyId } : {};
}
async function unchanged(action: () => Promise<void>) {
  const before = await snapshot();
  await action();
  expect(await snapshot()).toBe(before);
}
function publicFields(data: unknown) {
  if (!data || typeof data !== 'object') return;
  for (const [key, child] of Object.entries(data)) {
    expect([
      'gold',
      'rice',
      'commerce',
      'tech',
      'isNpc',
      'userId',
      'generalId',
      'sequence',
      'tick',
      'idempotencyKey',
      'passwordHash',
      'stack',
    ]).not.toContain(key);
    publicFields(child);
  }
}

describe('T2-07 / AC-M2-06·14 조약 후속 실제 HTTP·PG 권한', () => {
  it(
    'treaty.break success는 실제 입력을 한 번 처리하고 신의·조약·국가 메시지를 저장한다',
    authzCase('treaty.break', 'success', async () => {
      const before = await Promise.all([
        db.nation.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } }),
        db.city.findMany({ where: { worldId: f.worldId }, orderBy: { cityKey: 'asc' } }),
        db.general.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } }),
      ]);
      const result = await complete('treaty.break', { treatyId: f.treatyId });
      expect(result).toMatchObject({
        status: 'applied',
        kind: 'treaty.break',
        outcome: 'BROKEN',
        treatyId: f.treatyId,
        treaty: { status: 'BROKEN' },
      });
      const stored = await db.inputEvent.findFirstOrThrow({ where: { worldId: f.worldId, kind: 'treaty.break' } });
      const closed = await db.treaty.findUniqueOrThrow({
        where: { worldId_id: { worldId: f.worldId, id: Number(f.treatyId) } },
      });
      expect(closed).toMatchObject({ status: 'BROKEN', closedSequence: stored.sequence });
      expect(await db.inputEvent.count({ where: { worldId: f.worldId, kind: 'treaty.break' } })).toBe(1);
      expect(await db.nationTrust.findMany({ where: { worldId: f.worldId } })).toEqual([
        {
          worldId: f.worldId,
          nationId: 1,
          brokenTreaties: 1,
          lastBrokenTick: (stored.result as { tick: number }).tick,
        },
      ]);
      const messages = await db.message.findMany({ where: { worldId: f.worldId } });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        scope: 'NATION',
        senderId: null,
        senderNationId: null,
        recipientNationId: 2,
        body: '국가1 국가가 조약을 파기했습니다. 지금까지 파기 1회입니다.',
      });
      expect(
        await Promise.all([
          db.nation.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } }),
          db.city.findMany({ where: { worldId: f.worldId }, orderBy: { cityKey: 'asc' } }),
          db.general.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } }),
        ]),
      ).toEqual(before);
    }),
  );
  it(
    'treaty.tradeTargets success는 실제 수락한 교역 조약의 공개 후보만 보인다',
    authzCase('treaty.tradeTargets', 'success', async () =>
      unchanged(async () => {
        const result = value<Output['tradeTargets']>(await call('treaty.tradeTargets'));
        const treaty = await db.treaty.findUniqueOrThrow({
          where: { worldId_id: { worldId: f.worldId, id: Number(f.treatyId) } },
        });
        const world = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
        expect(result).toEqual({
          fromCityKey: 1,
          items: [
            {
              cityKey: 2,
              cityName: (
                await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId: f.worldId, cityKey: 2 } } })
              ).name,
              nation: { id: 2, name: '국가2', color: '#0000ff' },
              treatyId: f.treatyId,
              tradeEndsAt: toGameDate(world.startYear, treaty.endTick!),
            },
          ],
          blocked: null,
        });
        publicFields(result);
      }),
    ),
  );
  it(
    'treaty.trust success는 실제 파기 결과의 공개 횟수와 날짜만 보인다',
    authzCase('treaty.trust', 'success', async () => {
      expect(
        value<Output['trust']>(await call('treaty.trust')).items.every(
          (row) => row.brokenTreaties === 0 && row.lastBrokenAt === null,
        ),
      ).toBe(true);
      await complete('treaty.break', { treatyId: f.treatyId });
      await unchanged(async () => {
        const result = value<Output['trust']>(await call('treaty.trust'));
        const trust = await db.nationTrust.findUniqueOrThrow({
          where: { worldId_nationId: { worldId: f.worldId, nationId: 1 } },
        });
        const world = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
        expect(result.items).toEqual([
          {
            nation: { id: 1, name: '국가1', color: '#ff0000' },
            brokenTreaties: 1,
            lastBrokenAt: toGameDate(world.startYear, trust.lastBrokenTick),
          },
          ...[2, 3].map((id) => ({
            nation: { id, name: `국가${id}`, color: id === 2 ? '#0000ff' : '#00ff00' },
            brokenTreaties: 0,
            lastBrokenAt: null,
          })),
        ]);
        publicFields(result);
      });
    }),
  );
  for (const path of ['treaty.break', 'treaty.tradeTargets', 'treaty.trust'] as const) {
    it(
      `${path} unauthenticated는 무쿠키·위조·만료 세션을 막고 쓰지 않는다`,
      authzCase(path, 'unauthenticated', async () => {
        const expired = newSession(now);
        await db.session.create({ data: { id: expired.id, userId: f.users[0]!, expiresAt: new Date(now - 1) } });
        await unchanged(async () => {
          for (const cookie of [undefined, 'sid=short', `sid=${'A'.repeat(43)}`, `sid=${expired.token}`])
            error(await wire(path, { worldId: f.worldId, ...input(path) }, cookie), 401, 'UNAUTHORIZED');
        });
      }),
    );
    it(
      `${path} sanctioned는 실제 제재 세션을 막고 쓰지 않는다`,
      authzCase(path, 'sanctioned', async () =>
        unchanged(async () => {
          error(await call(path, input(path), 2), 401, 'UNAUTHORIZED');
        }),
      ),
    );
    it(
      `${path} invalidInput은 잘못된 입력과 행위자 주입을 막고 쓰지 않는다`,
      authzCase(path, 'invalidInput', async () =>
        unchanged(async () => {
          const variants: Record<string, unknown>[] = [
            { unexpected: true },
            { userId: f.users[0] },
            { generalId: 1 },
            { nationId: 1 },
            { worldId: '' },
          ];
          if (path === 'treaty.break')
            variants.push({ requestId: 'invalid' }, { treatyId: 1 }, { treatyId: '01' }, { treatyId: '' });
          for (const patch of variants) error(await call(path, { ...input(path), ...patch }), 400, 'BAD_REQUEST');
        }),
      ),
    );
    it(
      `${path} otherUser는 실제 계정·월드 경계를 지키고 쓰지 않는다`,
      authzCase(path, 'otherUser', async () => {
        const otherWorld = await fixture();
        await unchanged(async () => {
          if (path === 'treaty.break') {
            const missing = await call(path, { requestId: randomUUID(), treatyId: '2147483647' }, 1);
            const foreign = await call(path, input(path), 1);
            error(missing, 404, 'NOT_FOUND');
            error(foreign, 404, 'NOT_FOUND');
            expect(foreign.error).toEqual(missing.error);
            error(await call(path, input(path), 3), 403, 'FORBIDDEN');
          } else if (path === 'treaty.tradeTargets') {
            expect(value<Output['tradeTargets']>(await call(path, {}, 1))).toMatchObject({
              fromCityKey: 3,
              items: [],
              blocked: expect.any(String),
            });
          } else {
            const owner = value<Output['trust']>(await call(path));
            const outsider = value<Output['trust']>(await call(path, {}, 1));
            expect(outsider).toEqual(owner);
            publicFields(outsider);
          }
          error(await call(path, input(path), 4), 404, 'NOT_FOUND');
          error(await wire(path, { worldId: otherWorld.worldId, ...input(path) }, f.cookies[0]), 404, 'NOT_FOUND');
          error(await call(path, { ...input(path), worldId: `missing-${randomUUID()}` }), 404, 'NOT_FOUND');
        });
      }),
    );
  }
});
