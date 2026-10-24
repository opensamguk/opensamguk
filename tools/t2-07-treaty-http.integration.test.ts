import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Prisma, type PrismaClient } from '../packages/db/src/index';
import {
  calculateTreatyFee,
  selectWorldCapabilities,
  toGameDate,
  type TreatyClause,
} from '../packages/rules/src/index';
import { buildServer } from '../apps/server/src/server';
import { appRouter, type AppRouter } from '../apps/server/src/router';
import { authzCase } from '../apps/server/src/authz/case';
import { newSession, hashToken } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { readFixture } from '../apps/server/test/readFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, renewLease, releaseLease, type Lease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { pnpmCli } from './node-cli';

// AppRouter의 반환 타입만 읽는다. createCaller를 실행하지 않는다.
type Caller = ReturnType<AppRouter['createCaller']>['treaty'];
type Output = { [K in keyof Caller]: Awaited<ReturnType<Caller[K]>> };
type Path = `treaty.${keyof Output}`;
type State = Output['request'];
type Catalog = Array<{ name: string; oid: number }>;
type Session = { id: string; cookie: string };
type Wire = { status: number; data: unknown; error: { message: string; data: Record<string, unknown> } | undefined };
type Fixture = {
  worldId: string;
  state: Awaited<ReturnType<typeof readFixture>>;
  users: Array<{ id: string; email: string }>;
  sessions: Session[];
  lease: Lease | undefined;
  loop: TurnLoop | undefined;
  abortedAt: number | undefined;
};
const root = fileURLToPath(new URL('../', import.meta.url));
const migrationRoot = new URL('../packages/db/prisma/migrations/', import.meta.url);
const requiredPrefix = [
  '20261020000000_initial_world',
  '20261020010000_world_clock',
  '20261020020000_accounts',
  '20261020030000_engine_turns',
  '20261020040000_monthly_replay',
  '20261021030000_commands_war',
  '20261021040000_rankings',
  '20261021080000_engine_heartbeat',
  '20261023000000_world_outcome',
  '20261023010000_public_map_snapshot',
  '20261023020000_nation_display_archive',
  '20261023030000_messaging_realtime',
  '20261023040000_world_presets',
  '20261023050000_default_policy',
  '20261023060000_operation_plans',
  '20261023071000_nation_offices',
  '20261023072000_world_ext_slices',
  '20261023073000_treaties',
];
const databaseName = `t207_http_${randomUUID().replaceAll('-', '')}_test`;
const origin = 'http://treaty-http.test';
const password = randomUUID();
const note: TreatyClause[] = [{ kind: 'note', text: '기록' }];
const nap: TreatyClause[] = [{ kind: 'nonAggression', months: 12 }];
let admin: PrismaClient | undefined;
let db: PrismaClient;
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let base: string;
let catalogBefore: Catalog | undefined;
let created = false;
let ownOid: number | undefined;
let passwordHash: string;
let stopMigration: (() => Promise<void>) | undefined;
let f: Fixture;
const fixtures: Fixture[] = [];
const pendingFetches = new Set<Promise<Wire>>();
const lifecycle: Record<string, unknown> = {
  database: databaseName,
  sourceAccess: 'URL_TEMPLATE_ONLY',
  fixtureMutations: [],
};
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)))
    .digest('hex');

async function catalog(): Promise<Catalog> {
  return admin!.$queryRaw<Catalog>`SELECT datname AS name, oid::int AS oid FROM pg_database ORDER BY datname`;
}
async function ownIdentity() {
  const rows = await admin!.$queryRaw<
    Array<{ oid: number }>
  >`SELECT oid::int AS oid FROM pg_database WHERE datname = ${databaseName}`;
  return rows[0]?.oid;
}
async function migrate(url: string) {
  const names = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  expect(names.slice(0, requiredPrefix.length)).toEqual(requiredPrefix);
  const expected = await Promise.all(
    names.map(async (name) => ({
      name,
      checksum: createHash('sha256')
        .update(await readFile(new URL(`${name}/migration.sql`, migrationRoot)))
        .digest('hex'),
    })),
  );
  const env: NodeJS.ProcessEnv & { DATABASE_URL: string; TEST_DATABASE_URL: string } = {
    ...process.env,
    DATABASE_URL: url,
    TEST_DATABASE_URL: url,
  };
  if (
    new URL(env.DATABASE_URL).pathname !== `/${databaseName}` ||
    new URL(env.TEST_DATABASE_URL).pathname !== `/${databaseName}`
  )
    throw new Error('Migration 대상이 소유 DB와 다릅니다.');
  const migrateArgs = ['--filter', '@opensamguk/db', 'migrate'];
  const [command, args] =
    env.npm_execpath && /^pnpm\.(?:c|m)?js$/i.test(basename(env.npm_execpath))
      ? pnpmCli(migrateArgs, env)
      : process.platform === 'win32'
        ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm --filter @opensamguk/db migrate']]
        : ['pnpm', migrateArgs];
  const cancellation = new AbortController();
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
    signal: cancellation.signal,
  });
  lifecycle.migrationPid = child.pid;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  stopMigration = async () => {
    if (child.exitCode === null && !child.killed) cancellation.abort();
    await Promise.race([
      closed,
      delay(2000).then(() => {
        throw new Error('소유 migration 자식이 닫히지 않았습니다.');
      }),
    ]);
  };
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new Error('시험 migration 명령을 시작하지 못했습니다.')));
    child.once('close', resolve);
  });
  await closed;
  stopMigration = undefined;
  if (code !== 0) throw new Error('조약 HTTP 시험 migration이 실패했습니다.');
  const actual = await db.$queryRaw<Array<{ name: string; checksum: string; finished: boolean; rolledBack: boolean }>>`
    SELECT migration_name AS name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack"
    FROM _prisma_migrations ORDER BY migration_name`;
  expect(actual).toEqual(expected.map((row) => ({ ...row, finished: true, rolledBack: false })));
  lifecycle.migrations = actual.length;
}

beforeAll(async () => {
  // 접속 원본 DB에는 연결하지 않는다. URL의 접속 정보만 복제한다.
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error('TEST_DATABASE_URL이 필요합니다.');
  let source: URL;
  try {
    source = new URL(raw);
  } catch {
    throw new Error('TEST_DATABASE_URL 형식을 확인하세요.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(source.protocol) ||
    !/^[a-z][a-z0-9_]*_test$/.test(source.pathname.slice(1))
  )
    throw new Error('전용 테스트 접속 원본이 필요합니다.');
  const maintenance = new URL(source);
  maintenance.pathname = '/postgres';
  const own = new URL(source);
  own.pathname = `/${databaseName}`;
  admin = createDb(maintenance.href);
  catalogBefore = await catalog();
  if ((await ownIdentity()) !== undefined) throw new Error('새 시험 DB 이름이 이미 있습니다.');
  await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
  created = true;
  ownOid = await ownIdentity();
  if (ownOid === undefined) throw new Error('생성한 시험 DB의 OID를 확인하지 못했습니다.');
  lifecycle.createdOid = ownOid;
  db = createDb(own.href);
  const [connected] = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  expect(connected?.name).toBe(databaseName);
  await migrate(own.href);
  passwordHash = await hashPassword(password);
  app = await buildServer({ db, publicOrigin: origin, logging: false });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  const address = new URL(base);
  expect(address.hostname).toBe('127.0.0.1');
  expect(address.port).not.toBe('3001');
  expect(address.port).not.toBe('5173');
  lifecycle.httpPort = Number(address.port);
});

async function fixture(options: { legacy?: boolean; responderGold?: number } = {}): Promise<Fixture> {
  const state = await readFixture();
  const users = Array.from({ length: 7 }, () => {
    const id = randomUUID();
    return { id, email: `${id}@example.invalid` };
  });
  state.nations = Array.from({ length: 5 }, (_, i) => ({
    ...state.nations[0]!,
    id: i + 1,
    name: ['A', 'B', 'C', 'N', 'N2'][i]!,
    capitalCityKey: state.cities[[0, 1, 3, 4, 5][i]!]!.cityKey,
    isNpc: i >= 3,
    gold: i === 1 ? (options.responderGold ?? 100000) : i === 2 || i === 4 ? 0 : 100000,
  }));
  state.cities = state.cities.map((city, i) => ({ ...city, nationId: [1, 2, 1, 3, 4, 5][i] ?? null }));
  state.generals = state.generals.map((general, i) => ({
    ...general,
    userId: users[[0, 1, 3, 5][i]!]!.id,
    nationId: [1, 2, 3, 1][i]!,
    cityKey: state.cities[[0, 1, 3, 0][i]!]!.cityKey,
    officerLevel: i === 3 ? 1 : 12,
    nextTurnTick: 10000,
  }));
  state.diplomacies = [{ nationA: 1, nationB: 5, state: 'WAR', untilTick: 0 }];
  const owned: Fixture = {
    worldId: '',
    state,
    users,
    sessions: [],
    lease: undefined,
    loop: undefined,
    abortedAt: undefined,
  };
  fixtures.push(owned);
  await db.user.createMany({
    data: users.map((user, i) => ({
      ...user,
      passwordHash,
      status: i === 2 ? 'SANCTIONED' : i === 6 ? 'WITHDRAWN' : 'ACTIVE',
    })),
  });
  for (const user of users) {
    const value = newSession(Date.now());
    await db.session.create({ data: { id: value.id, userId: user.id, expiresAt: value.expiresAt } });
    owned.sessions.push({ id: value.id, cookie: `sid=${value.token}` });
  }
  const made = await saveInitialWorld(db, state, {
    name: `조약 HTTP ${randomUUID()}`,
    turnTermMinutes: 120,
    endYear: null,
    replayFormat: 'legacy',
    ...(options.legacy ? {} : { treatyFormat: 1 as const }),
  });
  owned.worldId = made.worldId;
  const world = await db.world.findUniqueOrThrow({ where: { id: owned.worldId } });
  expect(world.policyFromSequence).toBeNull();
  expect(selectWorldCapabilities(world).kind).toBe(options.legacy ? 'legacy' : 'caps');
  if (!options.legacy)
    expect(world.replayOrigin).toMatchObject({ version: 6, capabilities: { version: 1, treaty: { version: 1 } } });
  await controlClock(db, owned.worldId, 'start');
  return owned;
}
beforeEach(async () => {
  f = await fixture();
});

function fixtureChange(reason: string) {
  (lifecycle.fixtureMutations as string[]).push(reason);
}
afterEach(async () => {
  await Promise.allSettled([...pendingFetches]);
  for (const owned of fixtures.splice(0)) {
    // 버린 HTTP 응답의 서버 처리도 원래 5초 대기 창을 빠져나간 뒤 정리한다.
    if (owned.abortedAt !== undefined) await delay(Math.max(0, owned.abortedAt + 5100 - performance.now()));
    if (owned.lease) await releaseLease(db, owned.lease);
    if (owned.worldId) await db.world.deleteMany({ where: { id: owned.worldId } });
    await db.user.deleteMany({ where: { id: { in: owned.users.map((user) => user.id) } } });
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
  await attempt('HTTP_CLOSE', async () => {
    await app?.close();
  });
  await attempt('MIGRATION_CHILD_CLOSE', async () => {
    await stopMigration?.();
  });
  await attempt('OWN_POOL_CLOSE', async () => {
    if (db) await db.$disconnect();
  });
  if (admin) {
    if (created && ownOid !== undefined)
      await attempt('OWN_NORMAL_DROP', async () => {
        if ((await ownIdentity()) !== ownOid) throw new Error('OID가 달라졌습니다.');
        const connections = await admin!.$queryRaw<
          Array<{ count: number }>
        >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = ${databaseName}`;
        if (connections[0]?.count !== 0) throw new Error('시험 DB 연결이 남았습니다.');
        lifecycle.connectionsBeforeDrop = 0;
        await admin!.$executeRawUnsafe(`DROP DATABASE "${databaseName}"`);
        lifecycle.normalDrop = true;
        expect(await ownIdentity()).toBeUndefined();
        const remaining = await admin!.$queryRaw<
          Array<{ count: number }>
        >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = ${databaseName}`;
        expect(remaining[0]?.count).toBe(0);
        lifecycle.connectionsAfterDrop = 0;
      });
    if (created && ownOid === undefined) errors.push('CREATED_OID_UNAVAILABLE_NO_DROP');
    if (catalogBefore)
      await attempt('CATALOG_IDENTITY', async () => {
        const after = await catalog();
        expect(digest(after)).toBe(digest(catalogBefore));
        lifecycle.catalogIdentityPreserved = true;
        lifecycle.catalogCount = catalogBefore!.length;
      });
    await attempt('ADMIN_POOL_CLOSE', async () => {
      await admin!.$disconnect();
    });
  }
  console.info('T2-07 HTTP lifecycle', { ...lifecycle, cleanupErrors: errors });
  if (errors.length) throw new Error(`조약 HTTP 시험 정리 실패: ${errors.join(', ')}`);
});

async function wire(path: string, input: unknown, cookie?: string, signal?: AbortSignal): Promise<Wire> {
  const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
  const procedure = procedures[path];
  if (!procedure) throw new Error('실제 router에 없는 절차입니다.');
  const mutation = procedure._def.type === 'mutation';
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${base}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
      ...(signal ? { signal } : {}),
    },
  );
  const body = ((await response.json()) as Array<{ result?: { data: unknown }; error?: Wire['error'] }>)[0];
  if (!body) throw new Error('HTTP 응답 형식을 확인하지 못했습니다.');
  return { status: response.status, data: body.result?.data, error: body.error };
}
function value<T>(response: Wire): T {
  expect(response.status).toBe(200);
  expect(response.error).toBeUndefined();
  return response.data as T;
}
function error(response: Wire, code: string) {
  expect(response.error?.data.code).toBe(code);
  expect(response.status).toBe(
    (
      {
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        BAD_REQUEST: 400,
        CONFLICT: 409,
        PRECONDITION_FAILED: 412,
        INTERNAL_SERVER_ERROR: 500,
      } as Record<string, number>
    )[code],
  );
  expect(Object.keys(response.error!.data).sort()).toEqual(['code', 'httpStatus', 'path', 'reason']);
  expect(response.error!.data.reason).toBeNull();
}
function call(path: Path, input: Record<string, unknown>, user = 0, owned = f) {
  return wire(path, { worldId: owned.worldId, ...input }, owned.sessions[user]!.cookie);
}
async function poll(owned = f) {
  if (!owned.lease) {
    const lease = await acquireLease(db, owned.worldId);
    if (!lease) throw new Error('실제 엔진 리스를 얻지 못했습니다.');
    owned.lease = lease;
    owned.loop = new TurnLoop(db, lease);
  } else await renewLease(db, owned.lease);
  const result = await owned.loop!.poll();
  expect(result.executions).toEqual([]);
}
async function observed(requestId: string, kind: 'treaty.propose' | 'treaty.respond', user = 0, owned = f) {
  const deadline = performance.now() + 5000;
  while (true) {
    const event = await db.inputEvent.findFirst({
      where: { worldId: owned.worldId, userId: owned.users[user]!.id, idempotencyKey: `${kind}:${requestId}` },
    });
    if (event) {
      expect(event.status).toBe('PENDING');
      expect(event.sequence).toBeNull();
      expect(event.result).toBeNull();
      return event;
    }
    if (performance.now() >= deadline) throw new Error('실제 PENDING 접수를 관측하지 못했습니다.');
    await delay(10);
  }
}
function begin(
  path: 'treaty.propose' | 'treaty.respond',
  payload: Record<string, unknown>,
  user = 0,
  owned = f,
  requestId = randomUUID(),
  signal?: AbortSignal,
) {
  const response = wire(path, { worldId: owned.worldId, requestId, ...payload }, owned.sessions[user]!.cookie, signal);
  pendingFetches.add(response);
  void response.then(
    () => pendingFetches.delete(response),
    () => pendingFetches.delete(response),
  );
  return { requestId, response, pending: () => observed(requestId, path, user, owned) };
}
async function complete(
  path: 'treaty.propose' | 'treaty.respond',
  payload: Record<string, unknown>,
  user = 0,
  owned = f,
) {
  const request = begin(path, payload, user, owned);
  const event = await request.pending();
  await poll(owned);
  const result = value<State>(await request.response);
  expect(result.status).not.toBe('pending');
  const stored = await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
  expect(stored.status).toBe(result.status === 'applied' ? 'APPLIED' : 'REJECTED');
  return { ...request, result, event: stored };
}
async function proposal(clauses: TreatyClause[] = note, toNationId = 2, user = 0, owned = f) {
  const sent = await complete('treaty.propose', { toNationId, clauses }, user, owned);
  if (sent.result.status !== 'applied') throw new Error('HTTP 제안 fixture 실패');
  return { ...sent, treatyId: sent.result.treatyId };
}
async function snapshot(owned = f, includeEvents = true) {
  const worldId = owned.worldId;
  const rows = await Promise.all([
    db.world.findUnique({ where: { id: worldId } }),
    db.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    db.city.findMany({ where: { worldId }, orderBy: { cityKey: 'asc' } }),
    db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    db.diplomacy.findMany({ where: { worldId }, orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }] }),
    db.treaty.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    db.nationTurn.findMany({ where: { worldId }, orderBy: [{ nationId: 'asc' }, { slot: 'asc' }] }),
    db.engineLease.findUnique({ where: { worldId } }),
    db.engineHeartbeat.findUnique({ where: { worldId } }),
    db.session.findMany({ where: { userId: { in: owned.users.map((u) => u.id) } }, orderBy: { id: 'asc' } }),
    ...(includeEvents ? [db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } })] : []),
  ]);
  return digest(rows);
}
function input(path: Path): Record<string, unknown> {
  if (path === 'treaty.propose') return { requestId: randomUUID(), toNationId: 2, clauses: note };
  if (path === 'treaty.respond') return { requestId: randomUUID(), treatyId: '1', accept: true };
  if (path === 'treaty.request') return { requestId: randomUUID() };
  if (path === 'treaty.quote') return { toNationId: 2, clauses: note };
  return {};
}
async function unauthenticated(path: Path) {
  const before = await snapshot();
  for (const cookie of [undefined, 'sid=short', `sid=${'A'.repeat(43)}`])
    error(await wire(path, { worldId: f.worldId, ...input(path) }, cookie), 'UNAUTHORIZED');
  expect(await snapshot()).toBe(before);
}
async function sanctioned(path: Path) {
  const before = await snapshot();
  for (const user of [2, 6]) error(await call(path, input(path), user), 'UNAUTHORIZED');
  expect(await snapshot()).toBe(before);
}
async function invalid(path: Path, variants: Record<string, unknown>[]) {
  const before = await snapshot();
  for (const patch of [{ unexpected: true }, { generalId: 1 }, { nationId: 1 }, ...variants])
    error(await call(path, { ...input(path), ...patch }), 'BAD_REQUEST');
  expect(await snapshot()).toBe(before);
}
function privateFields(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  for (const [key, item] of Object.entries(data)) {
    expect([
      'gold',
      'rice',
      'tech',
      'isNpc',
      'closedSequence',
      'idempotencyKey',
      'sequence',
      'userId',
      'generalId',
      'by',
      'tick',
      'stack',
    ]).not.toContain(key);
    privateFields(item);
  }
}

describe('T2-07 / AC-M2-06 첫 세 조항 실제 HTTP H1~H30', () => {
  it(
    'H1 list success는 실제 조약·쪽 나누기·처리 중·자기 최근 결과와 안내를 보인다',
    authzCase('treaty.list', 'success', async () => {
      for (let i = 0; i < 29; i++) await proposal([{ kind: 'note', text: `기록 ${i}` }]);
      await proposal(note, 4);
      const t1 = await proposal(nap, 1, 1);
      const t2 = await proposal([{ kind: 'nonAggression', months: 6 }], 1, 1);
      let page = value<Output['list']>(await call('treaty.list', {}));
      for (const [id, months] of [
        [t1.treatyId, 12],
        [t2.treatyId, 6],
      ] as const)
        expect(page.items.find((item) => item.id === id)).toMatchObject({
          canAccept: { ok: true },
          canReject: { ok: true },
          estimate: { mine: calculateTreatyFee(2, months), theirs: calculateTreatyFee(1, months) },
        });
      const response = begin('treaty.respond', { treatyId: t1.treatyId, accept: true });
      await response.pending();
      page = value<Output['list']>(await call('treaty.list', {}));
      expect(page.items.find((item) => item.id === t1.treatyId)).toMatchObject({
        canAccept: { code: 'IN_PROGRESS' },
        canReject: { code: 'IN_PROGRESS' },
      });
      expect(page.pending).toContainEqual(
        expect.objectContaining({ requestId: response.requestId, kind: 'treaty.respond' }),
      );
      const lowPending = value<Output['list']>(await call('treaty.list', {}, 5));
      expect(lowPending.pending).toEqual(page.pending.map((item) => ({ ...item, requestId: null })));
      await poll();
      value<State>(await response.response);
      const t3 = await proposal(nap, 3);
      const c = value<Output['list']>(await call('treaty.list', {}, 3));
      expect(c.items.find((item) => item.id === t3.treatyId)).toMatchObject({
        canAccept: { code: 'INSUFFICIENT_GOLD' },
        canReject: { ok: true },
      });
      const declined = await proposal([{ kind: 'peace' }, ...nap], 5);
      expect(declined.result).toMatchObject({ status: 'applied', outcome: 'DECLINED' });
      const before = await snapshot();
      const first = value<Output['list']>(await call('treaty.list', {}));
      expect(Object.keys(first).sort()).toEqual([
        'canPropose',
        'items',
        'myRecent',
        'nextCursor',
        'pending',
        'targets',
      ]);
      expect(first.canPropose).toEqual({ ok: true });
      expect(first.targets.map((target) => target.nation.id)).toEqual([2, 3, 4, 5]);
      expect(first.targets.find((target) => target.nation.id === 5)).toMatchObject({
        relation: 'WAR',
        relationEndAt: null,
      });
      expect(first.items).toHaveLength(30);
      expect(first.nextCursor).toBe(first.items.at(-1)!.id);
      const second = value<Output['list']>(await call('treaty.list', { cursor: first.nextCursor }));
      const actual = await db.treaty.findMany({
        where: { worldId: f.worldId, OR: [{ fromNationId: 1 }, { toNationId: 1 }] },
        orderBy: { id: 'desc' },
      });
      expect([...first.items, ...second.items].map((item) => item.id)).toEqual(actual.map((item) => String(item.id)));
      expect(second.nextCursor).toBeNull();
      const all = [...first.items, ...second.items];
      expect(all.find((item) => item.id === t2.treatyId)).toMatchObject({
        canAccept: { code: 'TREATY_RELATION' },
        canReject: { ok: true },
      });
      for (const item of all) {
        expect(item.proposedAt).toEqual(toGameDate(f.state.startYear, item.proposedTick));
        if (item.status === 'PROPOSED') expect(item.estimate).not.toBeNull();
        if (item.status === 'ACTIVE') expect(item).toMatchObject({ estimate: null, cost: expect.any(Object) });
      }
      const recent = await db.inputEvent.findMany({
        where: {
          worldId: f.worldId,
          userId: f.users[0]!.id,
          kind: { in: ['treaty.propose', 'treaty.respond'] },
          status: { in: ['APPLIED', 'REJECTED'] },
        },
        orderBy: { sequence: 'desc' },
        take: 5,
      });
      expect(first.myRecent.map((row) => row.requestId)).toEqual(
        recent.map((row) => row.idempotencyKey.slice(row.kind.length + 1)),
      );
      expect(first.myRecent).toContainEqual(
        expect.objectContaining({ requestId: declined.requestId, result: 'APPLIED', outcome: 'DECLINED' }),
      );
      const low = value<Output['list']>(await call('treaty.list', {}, 5));
      expect(low.canPropose).toMatchObject({ code: 'NO_PERMISSION' });
      expect(low.myRecent).toEqual([]);
      expect(low.targets).toEqual(first.targets);
      for (let i = 0; i < first.items.length; i++) {
        const { canAccept, canReject, ...expected } = first.items[i]!;
        expect(low.items[i]).toMatchObject(expected);
        if (canAccept !== null || canReject !== null)
          expect(low.items[i]).toMatchObject({
            canAccept: { code: 'NO_PERMISSION' },
            canReject: { code: 'NO_PERMISSION' },
          });
      }
      expect(await snapshot()).toBe(before);
    }),
  );
  it(
    'H2 quote success는 비용과 도메인·대상·관계 문제를 구분하며 쓰지 않는다',
    authzCase('treaty.quote', 'success', async () => {
      const before = await snapshot();
      expect(value<Output['quote']>(await call('treaty.quote', { toNationId: 2, clauses: [...nap, ...note] }))).toEqual(
        { cost: { mine: calculateTreatyFee(2, 12), theirs: calculateTreatyFee(1, 12) }, problem: null },
      );
      for (const clauses of [
        [],
        [...note, ...note],
        [{ kind: 'nonAggression', months: 0 }],
        [{ kind: 'note', text: '가'.repeat(301) }],
      ])
        expect(value<Output['quote']>(await call('treaty.quote', { toNationId: 2, clauses }))).toMatchObject({
          cost: null,
          problem: { code: 'BAD_INPUT' },
        });
      expect(
        value<Output['quote']>(
          await call('treaty.quote', { toNationId: 2, clauses: [{ kind: 'passage', cityKeys: [1] }] }),
        ),
      ).toMatchObject({ cost: null, problem: { code: 'CLAUSE_NOT_CONNECTED' } });
      for (const toNationId of [1, 999999, 2147483648])
        expect(value<Output['quote']>(await call('treaty.quote', { toNationId, clauses: note }))).toMatchObject({
          cost: null,
          problem: { code: 'BAD_TARGET' },
        });
      expect(
        value<Output['quote']>(await call('treaty.quote', { toNationId: 2, clauses: [{ kind: 'peace' }] })),
      ).toMatchObject({ cost: { mine: 0, theirs: 0 }, problem: { code: 'TREATY_RELATION' } });
      expect(await snapshot()).toBe(before);
    }),
  );
  it(
    'H3 propose success는 실제 엔진의 사람 제안·NPC 수락·거절을 회수한다',
    authzCase('treaty.propose', 'success', async () => {
      const human = await proposal();
      expect(human.result).toMatchObject({
        status: 'applied',
        outcome: 'PROPOSED',
        treaty: { id: human.treatyId, respondByTick: expect.any(Number) },
      });
      const npc = await proposal(note, 4);
      expect(npc.result).toMatchObject({
        status: 'applied',
        outcome: 'ACCEPTED',
        treaty: { cost: { from: 0, to: 0 } },
      });
      expect(npc.event.result).toMatchObject({ by: 'NPC', cost: { from: 0, to: 0 } });
      const freePoor = await proposal(note, 5);
      expect(freePoor.result).toMatchObject({
        status: 'applied',
        outcome: 'ACCEPTED',
        treaty: { cost: { from: 0, to: 0 } },
      });
      const before = await db.nation.findMany({
        where: { worldId: f.worldId, id: { in: [1, 5] } },
        select: { id: true, gold: true },
        orderBy: { id: 'asc' },
      });
      const rejected = await proposal([{ kind: 'peace' }, ...nap], 5);
      expect(rejected.result).toMatchObject({ status: 'applied', outcome: 'DECLINED', treaty: { status: 'REJECTED' } });
      expect(rejected.event.result).toMatchObject({ by: 'NPC', outcome: 'DECLINED' });
      expect(
        await db.nation.findMany({
          where: { worldId: f.worldId, id: { in: [1, 5] } },
          select: { id: true, gold: true },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before);
      for (const sent of [human, npc, freePoor, rejected])
        expect(
          await db.inputEvent.count({
            where: { worldId: f.worldId, userId: f.users[0]!.id, idempotencyKey: `treaty.propose:${sent.requestId}` },
          }),
        ).toBe(1);
    }),
  );
  it(
    'H4 respond success는 실제 차감·명시 거절과 엔진 거절 값을 구분한다',
    authzCase('treaty.respond', 'success', async () => {
      const proposed = await proposal(nap);
      const accepted = await complete('treaty.respond', { treatyId: proposed.treatyId, accept: true }, 1);
      expect(accepted.result).toMatchObject({
        status: 'applied',
        outcome: 'ACCEPTED',
        treaty: { cost: { from: 200, to: 100 } },
      });
      expect((await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).gold).toBe(
        99800,
      );
      expect((await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 2 } } })).gold).toBe(
        99900,
      );
      const another = await proposal();
      expect((await complete('treaty.respond', { treatyId: another.treatyId, accept: false }, 1)).result).toMatchObject(
        { status: 'applied', outcome: 'DECLINED', treaty: { status: 'REJECTED' } },
      );
      const poor = await fixture({ responderGold: 0 });
      const unpaid = await proposal(nap, 2, 0, poor);
      const before = await db.treaty.findUniqueOrThrow({
        where: { worldId_id: { worldId: poor.worldId, id: Number(unpaid.treatyId) } },
      });
      const gold = await db.nation.findMany({
        where: { worldId: poor.worldId },
        select: { id: true, gold: true },
        orderBy: { id: 'asc' },
      });
      expect(
        (await complete('treaty.respond', { treatyId: unpaid.treatyId, accept: true }, 1, poor)).result,
      ).toMatchObject({ status: 'rejected', code: 'INSUFFICIENT_GOLD', reason: expect.any(String) });
      expect(
        await db.treaty.findUniqueOrThrow({
          where: { worldId_id: { worldId: poor.worldId, id: Number(unpaid.treatyId) } },
        }),
      ).toEqual(before);
      expect(
        await db.nation.findMany({
          where: { worldId: poor.worldId },
          select: { id: true, gold: true },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(gold);
    }),
  );
  it(
    'H5 request success는 같은 사용자 UUID의 실제 완료 결과를 그대로 회수한다',
    authzCase('treaty.request', 'success', async () => {
      const sent = await proposal();
      expect(value<State>(await call('treaty.request', { requestId: sent.requestId }))).toEqual(sent.result);
    }),
  );
  it(
    'H6 list unauthenticated',
    authzCase('treaty.list', 'unauthenticated', () => unauthenticated('treaty.list')),
  );
  it(
    'H7 quote unauthenticated',
    authzCase('treaty.quote', 'unauthenticated', () => unauthenticated('treaty.quote')),
  );
  it(
    'H8 propose unauthenticated',
    authzCase('treaty.propose', 'unauthenticated', () => unauthenticated('treaty.propose')),
  );
  it(
    'H9 respond unauthenticated',
    authzCase('treaty.respond', 'unauthenticated', () => unauthenticated('treaty.respond')),
  );
  it(
    'H10 request unauthenticated',
    authzCase('treaty.request', 'unauthenticated', () => unauthenticated('treaty.request')),
  );
  it(
    'H11 list otherUser는 자기 국가와 본인 기록만 보여 준다',
    authzCase('treaty.list', 'otherUser', async () => {
      const ab = await proposal(),
        an = await proposal(note, 4),
        ac = await proposal(nap, 3);
      const before = await snapshot();
      const list = value<Output['list']>(await call('treaty.list', {}, 3));
      expect(list.items.map((row) => row.id)).toContain(ac.treatyId);
      expect(list.items.map((row) => row.id)).not.toContain(ab.treatyId);
      expect(list.items.map((row) => row.id)).not.toContain(an.treatyId);
      expect(list.pending).toEqual([]);
      expect(list.myRecent).toEqual([]);
      expect(list.targets.map((row) => row.nation.id)).not.toContain(3);
      error(await call('treaty.list', {}, 4), 'NOT_FOUND');
      expect(await snapshot()).toBe(before);
    }),
  );
  it(
    'H12 quote otherUser는 장수와 현재 권한을 먼저 본다',
    authzCase('treaty.quote', 'otherUser', async () => {
      const before = await snapshot();
      error(await call('treaty.quote', input('treaty.quote'), 4), 'NOT_FOUND');
      error(await call('treaty.quote', input('treaty.quote'), 5), 'FORBIDDEN');
      expect(await snapshot()).toBe(before);
    }),
  );
  it(
    'H13 propose otherUser는 남의 장수 권한으로 접수하지 않는다',
    authzCase('treaty.propose', 'otherUser', async () => {
      const before = await snapshot();
      error(await call('treaty.propose', input('treaty.propose'), 4), 'NOT_FOUND');
      error(await call('treaty.propose', input('treaty.propose'), 5), 'FORBIDDEN');
      expect(await snapshot()).toBe(before);
    }),
  );
  it(
    'H14 respond otherUser는 남의 조약 존재를 구별하지 못한다',
    authzCase('treaty.respond', 'otherUser', async () => {
      const sent = await proposal();
      const before = await snapshot();
      const messages: unknown[] = [];
      for (const treatyId of [sent.treatyId, '999999', '2147483648']) {
        const reply = await call('treaty.respond', { requestId: randomUUID(), treatyId, accept: true }, 3);
        error(reply, 'NOT_FOUND');
        messages.push(reply.error!.message);
      }
      expect(new Set(messages).size).toBe(1);
      error(
        await call('treaty.respond', { requestId: randomUUID(), treatyId: sent.treatyId, accept: true }, 5),
        'FORBIDDEN',
      );
      expect(await snapshot()).toBe(before);
    }),
  );
  it(
    'H15 request otherUser는 남의 UUID를 회수하지 못한다',
    authzCase('treaty.request', 'otherUser', async () => {
      const sent = await proposal();
      const before = await snapshot();
      for (const requestId of [sent.requestId, randomUUID()])
        error(await call('treaty.request', { requestId }, 3), 'NOT_FOUND');
      expect(value<State>(await call('treaty.request', { requestId: sent.requestId }))).toEqual(sent.result);
      expect(await snapshot()).toBe(before);
    }),
  );
  it(
    'H16 list sanctioned',
    authzCase('treaty.list', 'sanctioned', () => sanctioned('treaty.list')),
  );
  it(
    'H17 quote sanctioned',
    authzCase('treaty.quote', 'sanctioned', () => sanctioned('treaty.quote')),
  );
  it(
    'H18 propose sanctioned',
    authzCase('treaty.propose', 'sanctioned', () => sanctioned('treaty.propose')),
  );
  it(
    'H19 respond sanctioned',
    authzCase('treaty.respond', 'sanctioned', () => sanctioned('treaty.respond')),
  );
  it(
    'H20 request sanctioned',
    authzCase('treaty.request', 'sanctioned', () => sanctioned('treaty.request')),
  );
  it(
    'H21 list invalidInput',
    authzCase('treaty.list', 'invalidInput', () =>
      invalid('treaty.list', [
        { cursor: 'x' },
        { cursor: '-1' },
        { cursor: '2147483648' },
        { status: 'ACTIVE' },
        { tab: 'incoming' },
        { includeTargets: true },
        { pendingCursor: '1' },
      ]),
    ),
  );
  it(
    'H22 quote invalidInput',
    authzCase('treaty.quote', 'invalidInput', () =>
      invalid('treaty.quote', [
        { toNationId: '2' },
        { toNationId: 0 },
        { clauses: {} },
        { clauses: [{ kind: 'unknown' }] },
        { clauses: [{ kind: 'nonAggression', months: '12' }] },
      ]),
    ),
  );
  it(
    'H23 propose invalidInput',
    authzCase('treaty.propose', 'invalidInput', () =>
      invalid('treaty.propose', [
        { userId: 'other' },
        { fromNationId: 2 },
        { requestId: 'bad' },
        { expiresInMonths: 6 },
      ]),
    ),
  );
  it(
    'H24 respond invalidInput',
    authzCase('treaty.respond', 'invalidInput', () =>
      invalid('treaty.respond', [{ treatyId: 1 }, { treatyId: '01' }, { accept: 'yes' }]),
    ),
  );
  it(
    'H25 request invalidInput',
    authzCase('treaty.request', 'invalidInput', () =>
      invalid('treaty.request', [{ kind: 'treaty.propose' }, { requestId: 'bad' }]),
    ),
  );

  it('H26 두 mutation의 nonce 재전송과 충돌은 원래 입력 하나만 쓴다', async () => {
    const clauses = [{ kind: 'note', text: '\u1100\u1161' }, ...nap];
    const original = begin('treaty.propose', { toNationId: 2, clauses });
    await original.pending();
    const retry = begin(
      'treaty.propose',
      { toNationId: 2, clauses: [...nap, { kind: 'note', text: '가' }] },
      0,
      f,
      original.requestId,
    );
    await retry.pending();
    error(await call('treaty.propose', { requestId: original.requestId, toNationId: 2, clauses: note }), 'CONFLICT');
    error(await call('treaty.respond', { requestId: original.requestId, treatyId: '1', accept: false }), 'CONFLICT');
    error(await call('treaty.propose', { requestId: randomUUID(), toNationId: 2, clauses }), 'CONFLICT');
    await poll();
    const result = value<State>(await original.response);
    expect(value<State>(await retry.response)).toEqual(result);
    if (result.status !== 'applied') throw new Error('nonce 제안 fixture 실패');
    fixtureChange('H26 완료 뒤 U0 직위만 낮춘 재전송 반례');
    await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { officerLevel: 1 } });
    expect(
      value<State>(await call('treaty.propose', { requestId: original.requestId, toNationId: 2, clauses })),
    ).toEqual(result);
    await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { officerLevel: 12 } });
    const respond = begin('treaty.respond', { treatyId: result.treatyId, accept: false }, 1);
    await respond.pending();
    const duplicate = begin('treaty.respond', { treatyId: result.treatyId, accept: false }, 1, f, respond.requestId);
    await duplicate.pending();
    error(
      await call('treaty.respond', { requestId: respond.requestId, treatyId: result.treatyId, accept: true }, 1),
      'CONFLICT',
    );
    await poll();
    const declined = value<State>(await respond.response);
    expect(value<State>(await duplicate.response)).toEqual(declined);
    expect(declined).toMatchObject({ status: 'applied', outcome: 'DECLINED' });
    const rejected = await complete('treaty.respond', { treatyId: result.treatyId, accept: true }, 1);
    expect(rejected.result).toMatchObject({ status: 'rejected', code: 'TREATY_NOT_PROPOSED' });
    expect(
      value<State>(
        await call('treaty.respond', { requestId: rejected.requestId, treatyId: result.treatyId, accept: true }, 1),
      ),
    ).toEqual(rejected.result);
    const bad = await complete('treaty.propose', { toNationId: 2, clauses: [] });
    expect(bad.result).toMatchObject({ status: 'rejected', code: 'BAD_INPUT' });
    expect(
      value<State>(await call('treaty.propose', { requestId: bad.requestId, toNationId: 2, clauses: [] })),
    ).toEqual(bad.result);
    await proposal();
    for (const [user, kind, requestId] of [
      [0, 'treaty.propose', original.requestId],
      [1, 'treaty.respond', respond.requestId],
      [1, 'treaty.respond', rejected.requestId],
      [0, 'treaty.propose', bad.requestId],
    ] as const)
      expect(
        await db.inputEvent.count({
          where: { worldId: f.worldId, userId: f.users[user]!.id, idempotencyKey: `${kind}:${requestId}` },
        }),
      ).toBe(1);
  });
  it('H27 응답 유실·새 로그인·최근 범위 밖·소속 상실 뒤에도 자기 결과를 회수한다', async () => {
    const controller = new AbortController();
    const lost = begin('treaty.propose', { toNationId: 2, clauses: note }, 0, f, randomUUID(), controller.signal);
    await lost.pending();
    controller.abort();
    f.abortedAt = performance.now();
    await expect(lost.response).rejects.toMatchObject({ name: 'AbortError' });
    await poll();
    const recovered = value<State>(await call('treaty.request', { requestId: lost.requestId }));
    expect(recovered).toMatchObject({ status: 'applied', outcome: 'PROPOSED' });
    const rejected = await complete('treaty.propose', { toNationId: 2, clauses: [] });
    expect(value<State>(await call('treaty.request', { requestId: rejected.requestId }))).toEqual(rejected.result);
    expect((await wire('auth.logout', undefined, f.sessions[0]!.cookie)).status).toBe(200);
    const encoded = JSON.stringify({ 0: { email: f.users[0]!.email, password } });
    const login = await fetch(`${base}/trpc/auth.login?batch=1`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: encoded,
    });
    expect(login.status).toBe(200);
    await login.arrayBuffer();
    const cookie = login.headers.get('set-cookie')?.match(/(?:^|,\s*)sid=([^;]+)/)?.[1];
    if (!cookie) throw new Error('실제 로그인 쿠키가 없습니다.');
    f.sessions[0] = { id: hashToken(cookie), cookie: `sid=${cookie}` };
    expect(value<State>(await call('treaty.request', { requestId: lost.requestId }))).toEqual(recovered);
    for (let i = 0; i < 6; i++) await proposal();
    expect(value<Output['list']>(await call('treaty.list', {})).myRecent.map((row) => row.requestId)).not.toContain(
      lost.requestId,
    );
    expect(value<State>(await call('treaty.request', { requestId: lost.requestId }))).toEqual(recovered);
    fixtureChange('H27 완료 뒤 U0 소속을 없앤 회수 반례');
    await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { nationId: null } });
    expect(value<State>(await call('treaty.request', { requestId: lost.requestId }))).toMatchObject({
      status: 'applied',
      treaty: null,
    });
  });
  it('H28 응답 허용 칸과 오류 formatter는 상대 국고·내부 기록을 숨긴다', async () => {
    const sent = await proposal();
    const declined = await complete('treaty.respond', { treatyId: sent.treatyId, accept: false }, 1);
    const quote = value<Output['quote']>(await call('treaty.quote', { toNationId: 2, clauses: note }));
    const list = value<Output['list']>(await call('treaty.list', {}));
    const recovered = value<State>(await call('treaty.request', { requestId: sent.requestId }));
    for (const data of [sent.result, declined.result, quote, list, recovered]) privateFields(data);
    expect(Object.keys(quote).sort()).toEqual(['cost', 'problem']);
    expect(Object.keys(list).length).toBe(6);
    expect(Object.keys(list.items[0]!).length).toBe(20);
    for (const target of list.targets) {
      expect(Object.keys(target).sort()).toEqual(['nation', 'relation', 'relationEndAt']);
      expect(Object.keys(target.nation).sort()).toEqual(['color', 'id', 'name']);
    }
    for (const row of list.myRecent)
      expect(Object.keys(row).sort()).toEqual(['kind', 'outcome', 'reason', 'requestId', 'result', 'treatyId']);
    if (recovered.status !== 'applied' || recovered.treaty === null) throw new Error('상세 허용 칸 fixture 실패');
    expect(Object.keys(recovered).sort()).toEqual(['kind', 'outcome', 'requestId', 'status', 'treaty', 'treatyId']);
    expect(Object.keys(recovered.treaty).sort()).toEqual([
      'clauses',
      'cost',
      'endTick',
      'fromNationId',
      'id',
      'incoming',
      'proposedTick',
      'respondByTick',
      'startTick',
      'status',
      'toNationId',
    ]);
    const pending = begin('treaty.propose', { toNationId: 2, clauses: note });
    await pending.pending();
    const low = value<Output['list']>(await call('treaty.list', {}, 5));
    expect(low.pending[0]?.requestId).toBeNull();
    expect(Object.keys(low.pending[0]!).sort()).toEqual([
      'accept',
      'kind',
      'requestId',
      'requestedBy',
      'toNation',
      'treatyId',
    ]);
    expect(Object.keys(low.pending[0]!.requestedBy)).toEqual(['name']);
    privateFields(low);
    await poll();
    value<State>(await pending.response);
    const richNpc = value<Output['quote']>(await call('treaty.quote', { toNationId: 4, clauses: nap }));
    const poorHuman = value<Output['quote']>(await call('treaty.quote', { toNationId: 3, clauses: nap }));
    expect(JSON.stringify(richNpc)).toBe(JSON.stringify(poorHuman));
    await proposal(nap, 3);
    fixtureChange('H28 상대 A 국고 sentinel만 바꾼 공개 응답 대조');
    await db.nation.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { gold: 0 } });
    const emptyGold = value<Output['list']>(await call('treaty.list', {}, 3));
    await db.nation.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { gold: 100000 } });
    const fullGold = value<Output['list']>(await call('treaty.list', {}, 3));
    expect(JSON.stringify(emptyGold)).toBe(JSON.stringify(fullGold));
    expect(JSON.stringify(fullGold)).not.toContain('COUNTERPART_UNAVAILABLE');
    const legacy = await fixture({ legacy: true });
    const legacyBefore = await snapshot(legacy);
    for (const path of ['treaty.list', 'treaty.quote', 'treaty.propose', 'treaty.respond', 'treaty.request'] as const)
      error(await call(path, input(path), 0, legacy), 'PRECONDITION_FAILED');
    expect(await snapshot(legacy)).toBe(legacyBefore);
    const broken = await db.treaty.findUniqueOrThrow({
      where: { worldId_id: { worldId: f.worldId, id: Number(sent.treatyId) } },
    });
    fixtureChange('H28 실제 완료 조약의 clauses만 파손한 음성 fixture; 게임 경로 증거 아님');
    try {
      await db.treaty.update({
        where: { worldId_id: { worldId: f.worldId, id: broken.id } },
        data: { clauses: [{ kind: 'note', text: '' }] },
      });
      const failure = await call('treaty.list', {});
      error(failure, 'INTERNAL_SERVER_ERROR');
      expect(failure.error!.message).toBe('요청을 처리하지 못했습니다.');
      privateFields(failure.error);
    } finally {
      await db.treaty.update({
        where: { worldId_id: { worldId: f.worldId, id: broken.id } },
        data: { clauses: broken.clauses as Prisma.InputJsonValue },
      });
    }
  });
  it('H29 반환 전 삭제·만료·제재·탈퇴를 새 시각으로 확인한다', async () => {
    for (const path of ['treaty.propose', 'treaty.respond'] as const)
      for (const change of ['delete', 'expire', 'SANCTIONED', 'WITHDRAWN'] as const) {
        const owned = await fixture();
        const proposed = path === 'treaty.respond' ? await proposal(note, 2, 0, owned) : undefined;
        const user = path === 'treaty.respond' ? 1 : 0;
        const request = begin(
          path,
          proposed ? { treatyId: proposed.treatyId, accept: false } : { toNationId: 2, clauses: note },
          user,
          owned,
        );
        await request.pending();
        fixtureChange(`H29 ${path} ${change}: 실제 PENDING 뒤 세션 또는 계정만 변경`);
        if (change === 'delete') {
          await db.session.delete({ where: { id: owned.sessions[user]!.id } });
          await poll(owned);
        } else if (change === 'expire') {
          await db.session.update({
            where: { id: owned.sessions[user]!.id },
            data: { expiresAt: new Date(Date.now() + 150) },
          });
          await delay(200);
        } else await db.user.update({ where: { id: owned.users[user]!.id }, data: { status: change } });
        const response = await request.response;
        error(response, 'UNAUTHORIZED');
        expect(response.data).toBeUndefined();
        expect(JSON.stringify(response.error)).not.toContain('treatyId');
        if (change !== 'delete') {
          const event = await db.inputEvent.findFirstOrThrow({
            where: {
              worldId: owned.worldId,
              userId: owned.users[user]!.id,
              idempotencyKey: `${path}:${request.requestId}`,
            },
          });
          expect(event.status).toBe('PENDING');
        }
      }
  });
  it('H30 원래 5초 대기 동안 API는 게임 상태를 바꾸지 않고 PENDING 한 행만 남긴다', async () => {
    const before = await snapshot(f, false);
    const oldEvents = await db.inputEvent.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } });
    const started = performance.now();
    const request = begin('treaty.propose', { toNationId: 2, clauses: note });
    const event = await request.pending();
    const result = value<State>(await request.response);
    expect(result).toEqual({ status: 'pending', requestId: request.requestId, kind: 'treaty.propose' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(5000);
    expect(await snapshot(f, false)).toBe(before);
    const after = await db.inputEvent.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } });
    expect(after.length).toBe(oldEvents.length + 1);
    expect(digest(after.filter((row) => row.id !== event.id))).toBe(digest(oldEvents));
    const [stored] = await db.$queryRaw<
      Array<{ status: string; sequence: number | null; sqlNull: boolean }>
    >`SELECT status::text AS status, sequence, result IS NULL AS "sqlNull" FROM "InputEvent" WHERE id = ${event.id}`;
    expect(stored).toEqual({ status: 'PENDING', sequence: null, sqlNull: true });
    await poll();
    expect(value<State>(await call('treaty.request', { requestId: request.requestId }))).toMatchObject({
      status: 'applied',
      outcome: 'PROPOSED',
    });
  });
});
