import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { saveInitialWorld, prepareInitialWorld, savePreparedInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { initializeResources } from './init-resources';
import { initializeIntegrationResources } from './integration-resources';
import { testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';
import { acquireLease, releaseLease, renewLease, type Lease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { preparePendingReset, processAdminReset, checkedResetTarget } from '../apps/engine/src/admin/reset';
import { processWorldCreateRequest } from '../apps/engine/src/admin/createRequests';
import { exportReplay, replayToEnd, replayArchive, resourceHashV3 } from '../apps/engine/src/replay';
import { hashState } from '../packages/shared/src/node/hashState';
import {
  ADMIN_RESET_KIND,
  TICKS_PER_MONTH,
  adminResetPayloadSchema,
  adminResetResourceSchema,
  adminResetResourcesSchema,
  checkReplayOrigin,
  emptyCityResourcesState,
  initialReplayStateWithRegistry,
  ruleRegistry,
  toWorldState,
} from '../packages/rules/src/index';
import { OwnedChildScope } from './test-support/owned-child-scope';
import { stopOwnedChild } from '../apps/engine/src/process-lifecycle';

// D1 접수와 D2/D3 실제 엔진·보존·재생 시험 소스다. 실행 근거는 별도 승인 뒤 남긴다.
type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string; connectionTimeoutMillis: number; query_timeout: number }) => Pg;
};
if (!process.env.TEST_DATABASE_URL) throw new Error('전용 시험 DB가 필요합니다.');
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('loopback 시험 서버가 필요합니다.');
for (const key of source.searchParams.keys())
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    throw new Error('접속 대상 질의 인자는 쓸 수 없습니다.');
const name = 't305_reset_d1_' + randomUUID().replaceAll('-', '') + '_test',
  target = new URL(source),
  adminUrl = new URL(source);
target.pathname = '/' + name;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 10000, query_timeout: 10000 });
const gate = new Client({ connectionString: target.href, connectionTimeoutMillis: 10000, query_timeout: 10000 });
const db = createDb(target.href),
  pending = new Set<Promise<unknown>>(),
  errors: unknown[] = [],
  logs: string[] = [],
  secrets = new Set<string>([target.href, target.password, decodeURIComponent(target.password)]);
const operationSignals = new AsyncLocalStorage<AbortSignal>(),
  controllers = new Set<AbortController>();
const childScope = new OwnedChildScope({
  label: 'admin-reset-engine',
  traceDir: process.env.OPENSAMGUK_CHILD_TRACE_DIR,
  repoRoot: fileURLToPath(new URL('../', import.meta.url)),
});
type EngineChild = {
  closed: boolean;
  stdoutEnded: boolean;
  stderrEnded: boolean;
  stop: () => Promise<void>;
  child: ReturnType<OwnedChildScope['start']>['child'];
  done: Promise<void>;
  code: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
};
const children: EngineChild[] = [];
let failed = false,
  oid: string | undefined,
  app: Awaited<ReturnType<typeof buildServer>> | undefined,
  address = '',
  passwordHash = '';
const origin = 'http://127.0.0.1:5173',
  policyVersion = 'reset-d1-fixture-v1';
const policy = {
  terms: { version: policyVersion, effectiveAt: '2026-01-01T00:00:00Z', bodyText: '격리 시험용 약관' },
  privacy: { version: policyVersion, effectiveAt: '2026-01-01T00:00:00Z', bodyText: '격리 시험용 개인정보 문서' },
};
type DatabaseOwnership = {
  baselineAbsent: boolean;
  creationAttempted: boolean;
  creationAcknowledged: boolean;
  initialOid: string | undefined;
};
type DatabaseAudit = {
  attempted: boolean;
  catalog: 'unexamined' | 'unknown' | 'absent' | 'present' | 'ambiguous';
  observedOid: string | null;
  identity: 'unknown' | 'absent' | 'matched' | 'recovered' | 'changed';
  connections: number | null;
  verified: boolean;
  preserved: boolean;
};
const ownership: DatabaseOwnership = {
  baselineAbsent: false,
  creationAttempted: false,
  creationAcknowledged: false,
  initialOid: undefined,
};
const databaseAudit: DatabaseAudit = {
  attempted: false,
  catalog: 'unexamined',
  observedOid: null,
  identity: 'unknown',
  connections: null,
  verified: false,
  preserved: true,
};
function fail(error: unknown) {
  failed = true;
  errors.push(error);
}
function track<T>(work: () => Promise<T>) {
  const promise = Promise.resolve().then(work);
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    (error) => {
      fail(error);
      pending.delete(promise);
    },
  );
  return promise;
}
async function checked<T>(work: () => Promise<T>, signal = operationSignals.getStore()) {
  signal?.throwIfAborted();
  const result = await work();
  signal?.throwIfAborted();
  return result;
}
async function hook<T>(label: string, work: (signal: AbortSignal) => Promise<T>, tracked = false, budgetMs = 110000) {
  const c = new AbortController();
  controllers.add(c);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => operationSignals.run(c.signal, () => work(c.signal)),
    original = tracked ? track(run) : Promise.resolve().then(run);
  try {
    return await Promise.race([
      original,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(label + ' 내부 기한 초과: DB 보존');
          fail(error);
          c.abort(error);
          reject(error);
        }, budgetMs);
      }),
    ]);
  } catch (error) {
    fail(error);
    c.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    void original.finally(() => controllers.delete(c)).catch(() => {});
  }
}
async function cleanupAttempt(work: () => Promise<unknown>, budgetMs = 10000, tracked = true) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const original = tracked ? track(work) : Promise.resolve().then(work);
  try {
    await Promise.race([
      original,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('자기 cleanup 미정착: DB 보존')), budgetMs);
      }),
    ]);
    return true;
  } catch (error) {
    fail(error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
// Work100s + independent finalclose10s leaves10s before the unchanged external120s hook.
async function cleanupWithReservedClose(
  work: (signal: AbortSignal) => Promise<void>,
  close: () => Promise<void>,
  workBudgetMs = 100000,
  closeReserveMs = 10000,
) {
  let closed: boolean;
  try {
    await hook('cleanup', work, false, workBudgetMs);
  } catch (error) {
    fail(error);
  } finally {
    closed = await cleanupAttempt(close, closeReserveMs);
  }
  return closed;
}
async function dropExactOwnedDatabase(client: Pg, expectedName: string, expectedOid: string, signal: AbortSignal) {
  if (!/^t305_reset_d1_[a-f0-9]{32}_test$/.test(expectedName) || !/^[1-9]\d*$/.test(expectedOid))
    throw new Error('자기 시험 DB 식별자를 확인하세요.');
  const identity = (
    await checked(
      () => client.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [expectedName]),
      signal,
    )
  ).rows;
  if (identity.length !== 1 || identity[0]!.oid !== expectedOid)
    throw new Error('DROP 직전 자기 DB 식별자 변경: DB 보존');
  signal.throwIfAborted();
  await checked(() => client.query('DROP DATABASE "' + expectedName + '"'), signal);
}
async function createOwnedDatabase(client: Pg, expectedName: string, marker: DatabaseOwnership, signal: AbortSignal) {
  if (!/^t305_reset_d1_[a-f0-9]{32}_test$/.test(expectedName)) throw new Error('자기 시험 DB 이름을 확인하세요.');
  const baseline = (
    await checked(() => client.query('SELECT oid FROM pg_database WHERE datname=$1', [expectedName]), signal)
  ).rows;
  if (baseline.length) throw new Error('처음부터 존재한 DB를 변경하지 않습니다.');
  marker.baselineAbsent = true;
  signal.throwIfAborted();
  // CREATE가 서버에 도달한 뒤 응답이 끊겨도 최종 감사에서 이름을 잃지 않는다.
  marker.creationAttempted = true;
  await checked(() => client.query('CREATE DATABASE "' + expectedName + '"'), signal);
  marker.creationAcknowledged = true;
  const rows = (
    await checked(
      () => client.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [expectedName]),
      signal,
    )
  ).rows;
  if (rows.length !== 1 || !/^[1-9]\d*$/.test(String(rows[0]!.oid)))
    throw new Error('생성한 DB 식별자 미확인: DB 보존');
  marker.initialOid = String(rows[0]!.oid);
}
async function auditCreatedDatabase(
  client: Pg,
  expectedName: string,
  marker: DatabaseOwnership,
  receipt: DatabaseAudit,
  signal: AbortSignal,
) {
  receipt.attempted = true;
  receipt.catalog = 'unknown';
  if (!marker.baselineAbsent || !marker.creationAttempted || !/^t305_reset_d1_[a-f0-9]{32}_test$/.test(expectedName))
    throw new Error('자기 CREATE 시도 근거 미확인: DB 보존');
  const rows = (
    await checked(
      () => client.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [expectedName]),
      signal,
    )
  ).rows;
  if (rows.length === 0) {
    receipt.catalog = 'absent';
    receipt.identity = marker.initialOid ? 'changed' : 'absent';
    if (marker.initialOid) throw new Error('생성한 DB 식별자 소실: DB 보존');
    receipt.verified = true;
    return;
  }
  if (rows.length !== 1 || !/^[1-9]\d*$/.test(String(rows[0]!.oid))) {
    receipt.catalog = 'ambiguous';
    throw new Error('자기 DB catalog 미확정: DB 보존');
  }
  receipt.catalog = 'present';
  receipt.observedOid = String(rows[0]!.oid);
  receipt.identity =
    marker.initialOid === undefined ? 'recovered' : marker.initialOid === receipt.observedOid ? 'matched' : 'changed';
  const disconnected = await checked(
    () => confirmDisconnectedDatabase(client, expectedName, receipt.observedOid!),
    signal,
  );
  receipt.connections = disconnected.connections;
  receipt.verified = true;
  if (receipt.identity === 'changed') throw new Error('자기 DB 식별자 변경: DB 보존');
}
async function settle() {
  while (pending.size) await Promise.allSettled([...pending]);
}
function it(title: string, work: (signal: AbortSignal) => Promise<void>, timeout = 30000) {
  test(
    title,
    ({ onTestFailed }) => {
      const c = new AbortController();
      controllers.add(c);
      onTestFailed(() => {
        fail(new Error('실패한 자기 초기화 준비 DB 보존'));
        c.abort();
      });
      const original = track(() => operationSignals.run(c.signal, () => work(c.signal)));
      void original
        .finally(() => {
          c.abort();
          controllers.delete(c);
        })
        .catch(() => {});
      return original;
    },
    timeout,
  );
}
beforeEach(settle);
async function tables() {
  return (
    await checked(() => gate.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"))
  ).rows.map((row) => String(row.tablename));
}
async function fullFootprint(exclude: readonly string[] = []) {
  const hash = createHash('sha256');
  for (const table of await tables()) {
    if (exclude.includes(table)) continue;
    operationSignals.getStore()?.throwIfAborted();
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    const rows = await checked(() =>
      gate.query(
        "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM " +
          quoted +
          ' t',
      ),
    );
    hash.update(table + '\n' + String(rows.rows[0]!.body) + '\n');
  }
  return hash.digest('hex');
}
beforeAll(
  () =>
    hook(
      'setup',
      async (signal) => {
        await checked(() => admin.connect(), signal);
        await createOwnedDatabase(admin, name, ownership, signal);
        oid = ownership.initialOid;
        await checked(() => admin.query('ALTER DATABASE "' + name + '" SET statement_timeout=10000'), signal);
        await checked(() => gate.connect(), signal);
        const directory = new URL('../packages/db/prisma/migrations/', import.meta.url),
          migrations = (await checked(() => readdir(directory), signal)).filter((x) => /^\d{14}_/.test(x)).sort();
        for (const migration of migrations) {
          signal.throwIfAborted();
          const sql = await checked(() => readFile(new URL(migration + '/migration.sql', directory), 'utf8'), signal);
          await checked(() => gate.query(sql), signal);
        }
        await checked(
          async () =>
            initializeResources(
              db,
              await checked(
                () => readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
                signal,
              ),
            ),
          signal,
        );
        await checked(() => initializeIntegrationResources(db), signal);
        passwordHash = await checked(() => hashPassword(randomUUID()), signal);
        secrets.add(passwordHash);
        app = await checked(
          () =>
            buildServer({
              db,
              publicOrigin: origin,
              legalPolicy: policy,
              emailVerificationRequired: true,
              logStream: {
                write(chunk: string) {
                  logs.push(chunk);
                },
              },
            }),
          signal,
        );
        await checked(async () => app!.ready(), signal);
        const bindErrors: unknown[] = [];
        for (let attempt = 0; attempt < 16; attempt++)
          try {
            address = await checked(() => app!.listen({ host: '127.0.0.1', port: randomInt(20000, 50000) }), signal);
            break;
          } catch (error) {
            if (
              app.server.listening ||
              !['EADDRINUSE', ...(process.platform === 'win32' ? ['EACCES'] : [])].includes(
                (error as NodeJS.ErrnoException).code ?? '',
              )
            )
              throw error;
            bindErrors.push(error);
          }
        if (!address) throw new AggregateError(bindErrors, '자기 listener bind 실패');
      },
      true,
    ),
  120000,
);

type Actor = { id: string; cookie: string; sessionId: string };
type Receipt = {
  userId: string;
  worldId: string;
  idempotencyKey: string;
  requestId: string;
  action: 'reset';
  status: 'PENDING';
  sequence: null;
  tick: null;
  plannedNewWorldId: string;
  result: null;
};
async function actor(role: 'ADMIN' | 'USER' = 'ADMIN', verified = true, consent = true): Promise<Actor> {
  const email = randomUUID() + '@example.test';
  secrets.add(email);
  const user = await checked(() =>
    db.user.create({
      data: {
        email,
        passwordHash,
        role,
        emailVerifiedAt: verified ? new Date() : null,
        consents: {
          create: consent
            ? [
                { docType: 'TERMS', version: policyVersion },
                { docType: 'PRIVACY', version: policyVersion },
              ]
            : [],
        },
      },
    }),
  );
  const session = newSession(Date.now());
  secrets.add(session.token);
  await checked(() => db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } }));
  return { id: user.id, cookie: 'sid=' + session.token, sessionId: session.id };
}
// 기존 공장으로 만든 전제 조건이다. CLI나 초기화 소비자 실행 근거로 세지 않는다.
async function world(options: { ruleFeatures?: ['policy'] } = {}) {
  const state = await checked(() =>
    loadInitialWorldFromDb(db, {
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: randomUUID(),
    }),
  );
  const selected =
    options.ruleFeatures === undefined
      ? {}
      : { ruleFeatures: [...new Set([...(state.ruleFeatures ?? []), ...options.ruleFeatures])] };
  const featureState = { ...state, ...selected };
  expect(state.nations).toHaveLength(21);
  expect(state.generals).toHaveLength(491);
  const saved = await checked(() =>
    saveInitialWorld(db, featureState, { name: '초기화 접수 보존', turnTermMinutes: 30, endYear: 200, ...selected }),
  );
  await checked(() => controlClock(db, saved.worldId, 'start'));
  await checked(() => controlClock(db, saved.worldId, 'pause'));
  return checked(() => db.world.findUniqueOrThrow({ where: { id: saved.worldId } }));
}
function input(owner: Actor, source: Awaited<ReturnType<typeof world>>) {
  return {
    expectedUserId: owner.id,
    worldId: source.id,
    idempotencyKey: randomUUID(),
    confirmName: source.name,
    expectedRevision: source.clockRevision,
    reason: '격리 시험 초기화',
  };
}
function query(payload: ReturnType<typeof input>) {
  return { expectedUserId: payload.expectedUserId, worldId: payload.worldId, idempotencyKey: payload.idempotencyKey };
}
async function call<Data = Receipt>(path: string, data: unknown, signal: AbortSignal, owner?: Actor) {
  return track(async () => {
    signal.throwIfAborted();
    const mutation = ['admin.world.requestReset', 'admin.world.create', 'general.create', 'turns.set'].includes(path),
      encoded = JSON.stringify({ 0: data });
    const response = await fetch(
      address + '/trpc/' + path + '?batch=1' + (mutation ? '' : '&input=' + encodeURIComponent(encoded)),
      {
        method: mutation ? 'POST' : 'GET',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        headers: {
          origin,
          ...(owner ? { cookie: owner.cookie } : {}),
          ...(mutation ? { 'content-type': 'application/json' } : {}),
        },
        ...(mutation ? { body: encoded } : {}),
      },
    );
    const raw = await response.text();
    signal.throwIfAborted();
    for (const secret of secrets) if (secret && raw.includes(secret)) throw new Error('응답 비공개 값 노출');
    const [item] = JSON.parse(raw) as Array<{
      result?: { data: Data };
      error?: { message: string; data: { code: string } };
    }>;
    return {
      status: response.status,
      data: item?.result?.data,
      code: item?.error?.data.code,
      message: item?.error?.message,
    };
  });
}
const request = (owner: Actor, payload: ReturnType<typeof input>, signal: AbortSignal) =>
  call('admin.world.requestReset', payload, signal, owner);
async function accepted(owner: Actor, payload: ReturnType<typeof input>, signal: AbortSignal) {
  const result = await request(owner, payload, signal);
  expect(result.status).toBe(200);
  if (!result.data) throw new Error('실제 초기화 접수 영수증이 필요합니다.');
  expect(result.data).toMatchObject({
    userId: owner.id,
    worldId: payload.worldId,
    idempotencyKey: payload.idempotencyKey,
    action: 'reset',
    status: 'PENDING',
    sequence: null,
    tick: null,
    result: null,
  });
  return result.data;
}
for (const path of ['admin.world.requestReset', 'admin.world.resetRequest'])
  for (const category of categories)
    it('AC-M3-04 ' + path + ' ' + category, async (signal) =>
      authzCase(path, category, async () => {
        const owner = await actor(category === 'otherUser' ? 'USER' : 'ADMIN'),
          source = await world(),
          payload = input(owner, source);
        if (category === 'sanctioned')
          await checked(() =>
            db.sanction.create({ data: { userId: owner.id, worldId: null, reason: '격리 시험', createdBy: owner.id } }),
          );
        if (path === 'admin.world.resetRequest' && category === 'success') await accepted(owner, payload, signal);
        const data = path === 'admin.world.requestReset' ? payload : query(payload),
          before = await fullFootprint(),
          game = await fullFootprint(['InputEvent', 'AuditLog']),
          result = await call(
            path,
            category === 'invalidInput' ? { ...data, actorId: owner.id } : data,
            signal,
            category === 'unauthenticated' ? undefined : owner,
          );
        if (category === 'success') {
          expect(result.status).toBe(200);
          if (path === 'admin.world.requestReset') {
            expect(result.data).toMatchObject({ status: 'PENDING', userId: owner.id });
            expect(
              await checked(() =>
                db.inputEvent.count({ where: { worldId: source.id, userId: owner.id, kind: 'admin.world.reset' } }),
              ),
            ).toBe(1);
            expect(
              await checked(() =>
                db.auditLog.count({ where: { worldId: source.id, action: 'world.reset.requested' } }),
              ),
            ).toBe(1);
            expect(await fullFootprint(['InputEvent', 'AuditLog'])).toBe(game);
          } else expect(await fullFootprint()).toBe(before);
        } else {
          expect(result.status).toBe(category === 'invalidInput' ? 400 : category === 'otherUser' ? 403 : 401);
          expect(await fullFootprint()).toBe(before);
        }
      })(),
    );
it('AC-M3-04 동일 키의 동시 접수는 하나의 frozen target/seed와 감사만 남긴다', async (signal) => {
  const owner = await actor(),
    source = await world(),
    payload = input(owner, source),
    before = await fullFootprint(['InputEvent', 'AuditLog']);
  const results = await Promise.allSettled([request(owner, payload, signal), request(owner, payload, signal)]);
  const rejected = results.filter((r) => r.status === 'rejected');
  if (rejected.length)
    throw new AggregateError(
      rejected.map((r) => r.reason),
      '동시 접수 본문 정착 실패',
    );
  const receipts = results.map((r) => (r.status === 'fulfilled' ? r.value : undefined));
  expect(receipts.every((r) => r?.status === 200)).toBe(true);
  expect(receipts[0]!.data).toEqual(receipts[1]!.data);
  const rows = await checked(() => db.inputEvent.findMany({ where: { worldId: source.id, userId: owner.id } }));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'PENDING', sequence: null, tick: null, generalId: null, result: null });
  const frozen = structuredClone(rows[0]!.payload);
  expect(await accepted(owner, payload, signal)).toEqual(receipts[0]!.data);
  expect((await checked(() => db.inputEvent.findUniqueOrThrow({ where: { id: rows[0]!.id } }))).payload).toEqual(
    frozen,
  );
  expect(
    await checked(() => db.auditLog.count({ where: { worldId: source.id, action: 'world.reset.requested' } })),
  ).toBe(1);
  expect(await fullFootprint(['InputEvent', 'AuditLog'])).toBe(before);
});
it('AC-M3-04 다른 intent와 다른 kind의 동일 키는 입력·감사 변경 없이 충돌한다', async (signal) => {
  const owner = await actor(),
    source = await world(),
    payload = input(owner, source);
  await accepted(owner, payload, signal);
  const before = await fullFootprint();
  expect((await request(owner, { ...payload, reason: '변경된 사유' }, signal)).status).toBe(409);
  expect((await request(owner, { ...payload, confirmName: '틀린 원본' }, signal)).status).toBe(409);
  expect(await fullFootprint()).toBe(before);
  const key = randomUUID();
  await checked(() =>
    db.inputEvent.create({
      data: { worldId: source.id, userId: owner.id, idempotencyKey: key, kind: 'unrelated', payload: {} },
    }),
  );
  const after = await fullFootprint();
  expect((await request(owner, { ...payload, idempotencyKey: key }, signal)).status).toBe(409);
  expect(await fullFootprint()).toBe(after);
});
it('AC-M3-04 다른 관리자의 같은 UUID 조회는 404이며 신원 ABA는 접수와 조회를 거부한다', async (signal) => {
  const owner = await actor(),
    other = await actor(),
    source = await world(),
    payload = input(owner, source);
  await accepted(owner, payload, signal);
  const before = await fullFootprint();
  expect(
    (await call('admin.world.resetRequest', { ...query(payload), expectedUserId: other.id }, signal, other)).status,
  ).toBe(404);
  for (const path of ['admin.world.requestReset', 'admin.world.resetRequest'])
    expect(
      (await call(path, path === 'admin.world.requestReset' ? payload : query(payload), signal, other)).status,
    ).toBe(401);
  expect(await fullFootprint()).toBe(before);
});
for (const path of ['admin.world.requestReset', 'admin.world.resetRequest'])
  for (const reason of ['email', 'consent', 'role', 'session', 'status'] as const)
    it('AC-M3-04 ' + path + ' 현재 ' + reason + ' 회수는 쓰기 없이 거부한다', async (signal) => {
      const owner = await actor(reason === 'role' ? 'USER' : 'ADMIN', reason !== 'email', reason !== 'consent'),
        source = await world(),
        payload = input(owner, source);
      if (reason === 'session') await checked(() => db.session.delete({ where: { id: owner.sessionId } }));
      if (reason === 'status')
        await checked(() => db.user.update({ where: { id: owner.id }, data: { status: 'WITHDRAWN' } }));
      const before = await fullFootprint(),
        result = await call(path, path === 'admin.world.requestReset' ? payload : query(payload), signal, owner);
      expect(result.status).toBe(['session', 'status'].includes(reason) ? 401 : 403);
      expect(await fullFootprint()).toBe(before);
    });
it('AC-M3-04 요청 감사 INSERT 거부는 실제 접수 전체를 롤백하고 고정 오류만 반환한다', async (signal) => {
  const owner = await actor(),
    source = await world(),
    payload = input(owner, source);
  const failures: unknown[] = [];
  try {
    await checked(() =>
      gate.query(
        `CREATE FUNCTION reset_d1_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='world.reset.requested' THEN RAISE EXCEPTION 'reset-d1-private-audit-refusal'; END IF; RETURN NEW; END $$`,
      ),
    );
    await checked(() =>
      gate.query(
        'CREATE TRIGGER reset_d1_refuse_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION reset_d1_refuse_audit()',
      ),
    );
    const before = await fullFootprint(),
      result = await request(owner, payload, signal);
    expect(result.status).toBe(500);
    expect(result.message).toBe('요청을 처리하지 못했습니다.');
    expect(await fullFootprint()).toBe(before);
    expect(await checked(() => db.inputEvent.count({ where: { worldId: source.id } }))).toBe(0);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const sql of [
      'DROP TRIGGER IF EXISTS reset_d1_refuse_audit ON "AuditLog"',
      'DROP FUNCTION IF EXISTS reset_d1_refuse_audit()',
    ])
      try {
        await gate.query(sql);
      } catch (error) {
        failures.push(error);
      }
  }
  if (failures.length) throw new AggregateError(failures, '요청 감사 롤백과 자기 trigger 정리 실패');
});
async function withLease<T>(
  worldId: string,
  signal: AbortSignal,
  work: (lease: Lease, signal: AbortSignal) => Promise<T>,
) {
  signal.throwIfAborted();
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('자기 초기화 실행권이 필요합니다.');
  const failures: unknown[] = [],
    stop = new AbortController(),
    effective = AbortSignal.any([signal, stop.signal]);
  let value: T | undefined;
  const renewal = (async () => {
    while (!effective.aborted) {
      try {
        await delay(Math.max(1, Math.floor(lease.ttlMs / 3)), undefined, { signal: effective });
      } catch (error) {
        if (!effective.aborted) failures.push(error);
        break;
      }
      if (effective.aborted) break;
      try {
        await renewLease(db, lease);
      } catch (error) {
        failures.push(error);
        stop.abort(error);
        break;
      }
    }
  })();
  try {
    effective.throwIfAborted();
    value = await operationSignals.run(effective, () => checked(() => track(() => work(lease, effective))));
  } catch (error) {
    failures.push(error);
  } finally {
    stop.abort();
    await renewal;
    try {
      await releaseLease(db, lease);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '초기화 본문과 자기 리스 정리 실패');
  return value!;
}
async function drain(loop: TurnLoop, signal: AbortSignal) {
  for (let batch = 0; batch < 16; batch++) {
    signal.throwIfAborted();
    const result = await checked(() => loop.poll(signal));
    if (!result.more) return result;
  }
  throw new Error('자기 초기화 입력 정리 batch 상한');
}
const apply = (worldId: string, signal: AbortSignal, hooks: ConstructorParameters<typeof TurnLoop>[2] = {}) =>
  withLease(worldId, signal, (lease, signal) => drain(new TurnLoop(db, lease, hooks), signal));
function spawnEngine(worldId: string, signal: AbortSignal): EngineChild {
  return spawnResetTool(
    [fileURLToPath(new URL('../apps/engine/src/index.ts', import.meta.url)), '--world', worldId],
    signal,
  );
}
function spawnResetTool(args: string[], signal: AbortSignal): EngineChild {
  signal.throwIfAborted();
  const started = childScope.start(process.execPath, ['--import', 'tsx', ...args], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, DATABASE_URL: target.href, TEST_DATABASE_URL: target.href },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let resolve!: () => void, stopping: Promise<void> | undefined, spawnError: unknown;
  const item: EngineChild = {
    child: started.child,
    closed: false,
    stdoutEnded: false,
    stderrEnded: false,
    code: undefined,
    signal: undefined,
    done: new Promise<void>((done) => {
      resolve = done;
    }),
    stop: () => {
      stopping ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            stopOwnedChild(item.child, item.done),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('자기 초기화 엔진 close 기한 초과: DB 보존')), 10000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (!item.closed || !item.stdoutEnded || !item.stderrEnded || spawnError)
          throw new Error('자기 초기화 엔진 close/streams 미확인: DB 보존');
      })();
      return stopping;
    },
  };
  children.push(item);
  // error는 즉시 실패로 남기며 실제 close와 두 stream end만 종료로 센다.
  item.child.once('error', (error) => {
    spawnError = error;
    fail(new Error('자기 초기화 엔진 spawn 실패'));
  });
  item.child.stdout!.on('data', (chunk) => logs.push(String(chunk)));
  item.child.stderr!.on('data', (chunk) => logs.push(String(chunk)));
  item.child.stdout!.once('end', () => {
    item.stdoutEnded = true;
  });
  item.child.stderr!.once('end', () => {
    item.stderrEnded = true;
  });
  const abort = () => {
    void track(item.stop);
  };
  signal.addEventListener('abort', abort, { once: true });
  item.child.once('close', (code, exitSignal) => {
    signal.removeEventListener('abort', abort);
    item.code = code;
    item.signal = exitSignal;
    item.closed = true;
    resolve();
  });
  if (signal.aborted) abort();
  return item;
}
async function eventFor(payload: ReturnType<typeof input>) {
  return checked(() =>
    db.inputEvent.findUniqueOrThrow({
      where: {
        worldId_userId_idempotencyKey: {
          worldId: payload.worldId,
          userId: payload.expectedUserId,
          idempotencyKey: payload.idempotencyKey,
        },
      },
    }),
  );
}
async function existingRows(worldIds: string[], sourceId: string, eventId: bigint) {
  const hash = createHash('sha256'),
    worldIdTables = new Set(
      (
        await checked(() =>
          gate.query(
            "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='worldId'",
          ),
        )
      ).rows.map((row) => String(row.table_name)),
    ),
    parts: string[] = [];
  // 전체 행과 기존 테이블 순서를 한 읽기 snapshot에서 유지한다.
  for (const [ordinal, table] of (await tables()).entries()) {
    operationSignals.getStore()?.throwIfAborted();
    if (['EngineLease', 'EngineHeartbeat'].includes(table)) continue;
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    let expression = 'to_jsonb(t)',
      where = '';
    if (table === 'World') {
      expression =
        "CASE WHEN id=$2 THEN to_jsonb(t)-ARRAY['status','endedAt','clockRevision','actionSequence'] ELSE to_jsonb(t) END";
      where = ' WHERE id=ANY($1::text[])';
    } else if (worldIdTables.has(table)) {
      where = ' WHERE "worldId"=ANY($1::text[])';
      if (table === 'InputEvent') {
        where += ' AND id<>$3::bigint';
      }
      if (table === 'AuditLog') {
        where += ' AND ("inputEventId" IS NULL OR "inputEventId"<>$3::bigint)';
      }
    }
    parts.push(
      'SELECT ' +
        ordinal +
        " AS ordinal,'" +
        table.replaceAll("'", "''") +
        "'::text AS name,COALESCE(jsonb_agg(snapshot ORDER BY snapshot::text),'[]'::jsonb)::text AS body FROM (SELECT " +
        expression +
        ' AS snapshot FROM ' +
        quoted +
        ' t' +
        where +
        ') rows',
    );
  }
  if (!parts.length) return hash.digest('hex');
  const rows = await checked(() =>
    gate.query(parts.join(' UNION ALL ') + ' ORDER BY ordinal', [worldIds, sourceId, String(eventId)]),
  );
  for (const row of rows.rows) hash.update(String(row.name) + '\n' + String(row.body) + '\n');
  return hash.digest('hex');
}
async function assertNoLiveLease(worldId: string) {
  const rows = (
    await checked(() =>
      gate.query(
        'SELECT "ownerId","fencingToken",("expiresAt" > (clock_timestamp() AT TIME ZONE \'UTC\')) AS active FROM "EngineLease" WHERE "worldId"=$1',
        [worldId],
      ),
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.active).toBe(false);
  expect(typeof rows[0]!.ownerId).toBe('string');
  expect(Number(rows[0]!.fencingToken)).toBeGreaterThan(0);
}
async function human(worldId: string, owner: Actor, signal: AbortSignal, index: number) {
  await checked(() => controlClock(db, worldId, 'resume'));
  const pendingRequest = call(
      'general.create',
      {
        worldId,
        name: '보존사람' + index,
        portraitId: null,
        leadership: 55,
        strength: 55,
        intel: 55,
        politics: 55,
        charm: 55,
      },
      signal,
      owner,
    ),
    settled = Promise.allSettled([pendingRequest]);
  const failures: unknown[] = [];
  try {
    await checked(() =>
      expect
        .poll(() => checked(() => db.inputEvent.count({ where: { worldId, userId: owner.id, status: 'PENDING' } })), {
          timeout: 10000,
        })
        .toBe(1),
    );
    await withLease(worldId, signal, async (lease, signal) => {
      const stored = await checked(() =>
        db.world.findUniqueOrThrow({ where: { id: worldId }, select: { clockTick: true } }),
      );
      await new TurnLoop(db, lease).advanceTo(stored.clockTick, signal);
    });
  } catch (error) {
    failures.push(error);
  }
  for (const result of await settled) if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, '정식 사람 입력 정착 실패');
  expect((await pendingRequest).status).toBe(200);
  await checked(() => controlClock(db, worldId, 'pause'));
  const general = await checked(() =>
    db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: owner.id } } }),
  );
  expect(await checked(() => db.generalTurn.count({ where: { worldId, generalId: general.id } }))).toBe(30);
}
const preservedWorlds: string[] = [];
let resetOwner: Actor | undefined,
  resetPayload: ReturnType<typeof input> | undefined,
  newWorldId = '';
it('AC-M3-04 D2 정식21국491명 두 월드에 실제 사람·30예약·기록을 준비한다', async (signal) => {
  resetOwner = await actor();
  for (const index of [0, 1]) {
    const source = await world({ ruleFeatures: ['policy'] });
    preservedWorlds.push(source.id);
    await human(source.id, resetOwner, signal, index);
    expect(await checked(() => db.nation.count({ where: { worldId: source.id } }))).toBe(21);
    expect(await checked(() => db.general.count({ where: { worldId: source.id, userId: null } }))).toBe(491);
  }
});
it('AC-M3-04 D2 실제 접수·엔진은 원본·타월드·사람·30칸을 보존하고 새 PREOPEN만 만든다', async (signal) => {
  if (!resetOwner) throw new Error('앞선 정식 사람 고정물이 필요합니다.');
  const source = await checked(() => db.world.findUniqueOrThrow({ where: { id: preservedWorlds[0]! } }));
  resetPayload = input(resetOwner, source);
  const receipt = await accepted(resetOwner, resetPayload, signal),
    event = await eventFor(resetPayload);
  const before = await existingRows(preservedWorlds, source.id, event.id);
  expect(await apply(source.id, signal)).toMatchObject({ status: 'ENDED' });
  const current = await eventFor(resetPayload);
  expect(current.status).toBe('APPLIED');
  newWorldId = adminResetPayloadSchema.parse(current.payload).plannedNewWorldId;
  expect(newWorldId).toBe(receipt.plannedNewWorldId);
  const ended = await checked(() => db.world.findUniqueOrThrow({ where: { id: source.id } })),
    targetWorld = await checked(() => db.world.findUniqueOrThrow({ where: { id: newWorldId } }));
  checkedResetTarget(ended, current, targetWorld);
  expect(ended).toMatchObject({
    status: 'ENDED',
    clockTick: source.clockTick,
    clockRevision: source.clockRevision + 1,
    seed: source.seed,
    replayOrigin: source.replayOrigin,
  });
  expect(targetWorld).toMatchObject({
    status: 'PREOPEN',
    clockTick: 0,
    clockRevision: 0,
    startedAt: null,
    endedAt: null,
    name: source.name,
    scenarioKey: source.scenarioKey,
    mapKey: source.mapKey,
    preset: source.preset,
    ruleFeatures: source.ruleFeatures,
  });
  expect(await existingRows(preservedWorlds, source.id, event.id)).toBe(before);
  expect(await checked(() => db.worldResult.count({ where: { worldId: source.id } }))).toBe(0);
  expect(await checked(() => db.general.count({ where: { worldId: newWorldId } }))).toBe(491);
  expect(await checked(() => db.general.count({ where: { worldId: newWorldId, userId: { not: null } } }))).toBe(0);
  expect(await checked(() => db.generalTurn.count({ where: { worldId: newWorldId } }))).toBe(491 * 30);
  expect(await checked(() => db.auditLog.count({ where: { worldId: source.id, action: 'world.reset.applied' } }))).toBe(
    1,
  );
  await assertNoLiveLease(source.id);
});
it('AC-M3-04 D3 원본·새 월드 독립 archive와 동일키 조회·재시작은 새 월드를 더 만들지 않는다', async (signal) => {
  if (!resetOwner || !resetPayload || !newWorldId) throw new Error('실제 초기화 결과가 필요합니다.');
  const oldArchive = await checked(() => exportReplay(db, resetPayload!.worldId)),
    newArchive = await checked(() => exportReplay(db, newWorldId));
  expect(replayToEnd(oldArchive)).toMatchObject({ reason: 'ADMIN_RESET', winnerNationId: null });
  expect(replayToEnd(JSON.parse(JSON.stringify(oldArchive)))).toEqual(replayToEnd(oldArchive));
  expect(newArchive.origin.initial.seed).toBe(
    adminResetPayloadSchema.parse((await eventFor(resetPayload)).payload).effectiveSeed,
  );
  const count = await checked(() => db.world.count()),
    first = await call('admin.world.resetRequest', query(resetPayload), signal, resetOwner);
  expect(first.status).toBe(200);
  expect(await request(resetOwner, resetPayload, signal)).toEqual(first);
  expect(await apply(resetPayload.worldId, signal)).toMatchObject({ status: 'ENDED' });
  expect(await checked(() => db.world.count())).toBe(count);
  expect(await apply(newWorldId, signal)).toMatchObject({ status: 'PREOPEN' });
  expect((await checked(() => db.world.findUniqueOrThrow({ where: { id: newWorldId } }))).startedAt).toBeNull();
});
it('AC-M3-04 D3 새 정식 월드는 명시 시작 뒤 한 달·동일 시드 재생을 두 번 통과한다', async (signal) => {
  if (!newWorldId) throw new Error('새 정식 월드가 필요합니다.');
  await checked(() => controlClock(db, newWorldId, 'start'));
  await withLease(newWorldId, signal, (lease, signal) => new TurnLoop(db, lease).advanceTo(TICKS_PER_MONTH, signal));
  await checked(() => controlClock(db, newWorldId, 'pause'));
  const archive = await checked(() => exportReplay(db, newWorldId)),
    first = replayArchive(archive, 1);
  expect(first).toHaveLength(1);
  expect(replayArchive(JSON.parse(JSON.stringify(archive)), 1)).toEqual(first);
}, 120000);
for (const mode of ['role', 'status', 'sanction', 'logout', 'revision', 'name', 'state'] as const)
  it('AC-M3-04 D2 접수 뒤 현재 ' + mode + ' 재검사', async (signal) => {
    const owner = await actor(),
      source = await world(),
      payload = input(owner, source);
    await accepted(owner, payload, signal);
    if (mode === 'role') await checked(() => db.user.update({ where: { id: owner.id }, data: { role: 'USER' } }));
    if (mode === 'status')
      await checked(() => db.user.update({ where: { id: owner.id }, data: { status: 'WITHDRAWN' } }));
    if (mode === 'sanction')
      await checked(() =>
        db.sanction.create({ data: { userId: owner.id, reason: '접수 뒤 제재', createdBy: owner.id } }),
      );
    if (mode === 'logout') await checked(() => db.session.delete({ where: { id: owner.sessionId } }));
    if (mode === 'revision')
      await checked(() => db.world.update({ where: { id: source.id }, data: { clockRevision: { increment: 1 } } }));
    if (mode === 'name')
      await checked(() => db.world.update({ where: { id: source.id }, data: { name: '변경된 이름' } }));
    if (mode === 'state')
      await checked(() => db.world.update({ where: { id: source.id }, data: { status: 'PREOPEN' } }));
    const count = await checked(() => db.world.count());
    await apply(source.id, signal);
    expect((await eventFor(payload)).status).toBe(mode === 'logout' ? 'APPLIED' : 'REJECTED');
    expect(await checked(() => db.world.count())).toBe(count + (mode === 'logout' ? 1 : 0));
    await assertNoLiveLease(source.id);
  });
for (const table of ['World', 'Nation', 'General', 'GeneralTurn', 'AuditLog'] as const)
  it('AC-M3-04 D2 ' + table + ' 실제 INSERT 거부는 원본·mapping·새 월드 전체를 롤백한다', async (signal) => {
    // 초기 GeneralTurn 쓰기는 정책 기능을 고른 월드에서만 발생한다.
    const owner = await actor(),
      source = await world(table === 'GeneralTurn' ? { ruleFeatures: ['policy'] } : {}),
      payload = input(owner, source);
    await accepted(owner, payload, signal);
    const event = await eventFor(payload),
      planned = adminResetPayloadSchema.parse(event.payload).plannedNewWorldId;
    const failures: unknown[] = [];
    try {
      await checked(() =>
        gate.query(
          'CREATE FUNCTION reset_apply_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
            (table === 'AuditLog'
              ? "IF NEW.action='world.reset.applied' THEN RAISE EXCEPTION 'reset-private-refusal'; END IF; RETURN NEW;"
              : "RAISE EXCEPTION 'reset-private-refusal';") +
            ' END $$',
        ),
      );
      await checked(() =>
        gate.query(
          'CREATE TRIGGER reset_apply_refuse BEFORE INSERT ON "' +
            table +
            '" FOR EACH ROW EXECUTE FUNCTION reset_apply_refuse()',
        ),
      );
      await withLease(source.id, signal, async (lease, signal) => {
        const before = await fullFootprint(['EngineLease']);
        await expect(new TurnLoop(db, lease).poll(signal)).rejects.toThrow();
        expect(await fullFootprint(['EngineLease'])).toBe(before);
        expect((await eventFor(payload)).status).toBe('PENDING');
        expect(await checked(() => db.world.count({ where: { id: planned } }))).toBe(0);
      });
      await assertNoLiveLease(source.id);
    } catch (error) {
      failures.push(error);
    } finally {
      for (const sql of [
        'DROP TRIGGER IF EXISTS reset_apply_refuse ON "' + table + '"',
        'DROP FUNCTION IF EXISTS reset_apply_refuse()',
      ])
        try {
          await gate.query(sql);
        } catch (error) {
          failures.push(error);
        }
    }
    if (failures.length) throw new AggregateError(failures, '초기화 rollback와 trigger 정리 실패');
  });
for (const mode of ['hook', 'abort', 'fence'] as const)
  it('AC-M3-04 D2 commit 직전 ' + mode + ' 실패는 적용 전체를 롤백한다', async (signal) => {
    const owner = await actor(),
      source = await world(),
      payload = input(owner, source);
    await accepted(owner, payload, signal);
    const abort = new AbortController(),
      effective = AbortSignal.any([signal, abort.signal]);
    await withLease(source.id, signal, async (lease, signal) => {
      const before = await fullFootprint(['EngineLease']);
      await expect(
        new TurnLoop(db, lease, {
          beforeCommit: async (tx) => {
            if (mode === 'hook') throw new Error('commit 시험 거부');
            if (mode === 'abort') abort.abort();
            if (mode === 'fence')
              await tx.$executeRaw`UPDATE "EngineLease" SET "fencingToken"="fencingToken"+1 WHERE "worldId"=${source.id}`;
          },
        }).poll(AbortSignal.any([signal, effective])),
      ).rejects.toThrow();
      expect(await fullFootprint(['EngineLease'])).toBe(before);
    });
    await assertNoLiveLease(source.id);
  });
it('AC-M3-04 D2 두 소비자와 두 관리자 요청은 APPLIED1·target1만 남긴다', async (signal) => {
  const source = await world(),
    first = await actor(),
    second = await actor(),
    a = input(first, source),
    b = input(second, source);
  await accepted(first, a, signal);
  await accepted(second, b, signal);
  signal.throwIfAborted();
  const count = await checked(() => db.world.count()),
    leases = await Promise.allSettled([acquireLease(db, source.id), acquireLease(db, source.id)]);
  const failures = leases.filter((row) => row.status === 'rejected').map((row) => row.reason),
    owned = leases
      .filter((row) => row.status === 'fulfilled')
      .map((row) => row.value)
      .filter((row): row is Lease => row !== null);
  try {
    if (!failures.length) {
      signal.throwIfAborted();
      expect(owned).toHaveLength(1);
      await drain(new TurnLoop(db, owned[0]!), signal);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    const results = await Promise.allSettled(owned.map((lease) => releaseLease(db, lease)));
    for (const row of results) if (row.status === 'rejected') failures.push(row.reason);
  }
  if (failures.length) throw new AggregateError([...new Set(failures)], '동시 소비자와 리스 정리 실패');
  expect(
    await checked(() =>
      db.inputEvent.count({ where: { worldId: source.id, kind: ADMIN_RESET_KIND, status: 'APPLIED' } }),
    ),
  ).toBe(1);
  expect(
    await checked(() =>
      db.inputEvent.count({ where: { worldId: source.id, kind: ADMIN_RESET_KIND, status: 'REJECTED' } }),
    ),
  ).toBe(1);
  expect(await checked(() => db.world.count())).toBe(count + 1);
  await assertNoLiveLease(source.id);
});
it('AC-M3-04 D2 준비 뒤 원본 설정 pin 변경은 새 target을 쓰지 않는다', async (signal) => {
  const owner = await actor(),
    source = await world(),
    payload = input(owner, source);
  await accepted(owner, payload, signal);
  await withLease(source.id, signal, async (lease, signal) => {
    const event = await eventFor(payload),
      prepared = await preparePendingReset(db, lease, event, signal);
    await checked(() =>
      db.world.update({ where: { id: source.id }, data: { turnTermMinutes: source.turnTermMinutes + 1 } }),
    );
    await checked(() =>
      db.$transaction(
        async (tx) => {
          const { lockLease, assertLease } = await import('../apps/engine/src/lease');
          await lockLease(tx, lease);
          await tx.$queryRaw`SELECT id FROM "World" WHERE id=${source.id} FOR UPDATE`;
          const current = await tx.world.findUniqueOrThrow({ where: { id: source.id } });
          await processAdminReset(tx, current, event, prepared, signal);
          signal.throwIfAborted();
          await assertLease(tx, lease);
        },
        { timeout: 30000 },
      ),
    );
    expect(await eventFor(payload)).toMatchObject({ status: 'REJECTED', result: { code: 'RESOURCE_INVALID' } });
    expect(
      await checked(() =>
        db.world.count({ where: { id: adminResetPayloadSchema.parse(event.payload).plannedNewWorldId } }),
      ),
    ).toBe(0);
  });
});

it('AC-M3-04 D2 이미 존재한 target UUID는 성공으로 추정하지 않고 그대로 보존한다', async (signal) => {
  const owner = await actor(),
    source = await world(),
    payload = input(owner, source);
  await accepted(owner, payload, signal);
  const event = await eventFor(payload),
    planned = adminResetPayloadSchema.parse(event.payload).plannedNewWorldId;
  const initial = await checked(() =>
    loadInitialWorldFromDb(db, {
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'unrelated-target',
    }),
  );
  const prepared = prepareInitialWorld(initial, { name: '기존 target 보존', turnTermMinutes: 30, endYear: null });
  await checked(() => db.$transaction((tx) => savePreparedInitialWorld(tx, prepared, planned), { timeout: 30000 }));
  const before = await existingRows([source.id, planned], source.id, event.id),
    count = await checked(() => db.world.count());
  await apply(source.id, signal);
  expect(await eventFor(payload)).toMatchObject({ status: 'REJECTED', result: { code: 'TARGET_EXISTS' } });
  expect(await existingRows([source.id, planned], source.id, event.id)).toBe(before);
  expect(await checked(() => db.world.count())).toBe(count);
});
it('AC-M3-04 D2 현재 User 잠금 대기 뒤 권한 회수는 실제 source·target 쓰기를 막는다', async (signal) => {
  const owner = await actor(),
    source = await world(),
    payload = input(owner, source);
  await accepted(owner, payload, signal);
  const failures: unknown[] = [];
  let applying: Promise<unknown> | undefined;
  try {
    await checked(() => gate.query('BEGIN'));
    const blocker = Number((await checked(() => gate.query('SELECT pg_backend_pid() AS pid'))).rows[0]!.pid);
    await checked(() => gate.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [owner.id]));
    applying = apply(source.id, signal);
    const settled = Promise.allSettled([applying]);
    await checked(() =>
      expect
        .poll(
          async () => {
            // gate 트랜잭션의 통계 snapshot을 재사용하지 않는 독립 조회다.
            const rows = await checked(
              () =>
                db.$queryRaw<Array<{ pid: number }>>`
                SELECT pid FROM pg_stat_activity
                WHERE datname=${name} AND pid<>${blocker}
                  AND ${blocker}=ANY(pg_blocking_pids(pid))
                  AND query LIKE '%"User"%FOR SHARE%'
              `,
            );
            return rows.length;
          },
          { timeout: 5000 },
        )
        .toBe(1),
    );
    await checked(() => gate.query('UPDATE "User" SET role=\'USER\' WHERE id=$1', [owner.id]));
    await checked(() => gate.query('COMMIT'));
    for (const result of await settled) if (result.status === 'rejected') failures.push(result.reason);
    expect(await eventFor(payload)).toMatchObject({ status: 'REJECTED', result: { code: 'ADMIN_REQUIRED' } });
    const planned = adminResetPayloadSchema.parse((await eventFor(payload)).payload).plannedNewWorldId;
    expect(await checked(() => db.world.count({ where: { id: planned } }))).toBe(0);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await gate.query('ROLLBACK');
    } catch (error) {
      failures.push(error);
    }
    if (applying) {
      const result = await Promise.allSettled([applying]);
      for (const row of result) if (row.status === 'rejected') failures.push(row.reason);
    }
  }
  if (failures.length) throw new AggregateError(failures, '현재 권한 경합과 자기 gate 정리 실패');
});
let crashPayload: ReturnType<typeof input> | undefined,
  crashPlanned = '';
it('AC-M3-04 D2 실제 프로세스 crash용 정식 요청과 첫 UUID·시드를 고정한다', async (signal) => {
  const owner = await actor(),
    source = await world();
  crashPayload = input(owner, source);
  await accepted(owner, crashPayload, signal);
  const event = await eventFor(crashPayload);
  crashPlanned = adminResetPayloadSchema.parse(event.payload).plannedNewWorldId;
  expect(await checked(() => db.world.count({ where: { id: crashPlanned } }))).toBe(0);
});
it('AC-M3-04 D2 실제 --world 엔진 INSERT 대기 중 SIGKILL은 PENDING과 원본 전체를 보존한다', async (signal) => {
  if (!crashPayload) throw new Error('자기 crash 요청이 필요합니다.');
  const payload = crashPayload,
    failures: unknown[] = [];
  let child: EngineChild | undefined;
  try {
    await checked(() => gate.query('SELECT pg_advisory_lock(73429,91247)'));
    const blocker = Number((await checked(() => gate.query('SELECT pg_backend_pid() AS pid'))).rows[0]!.pid);
    await checked(() =>
      gate.query(
        "CREATE FUNCTION reset_crash_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='" +
          crashPlanned +
          "' THEN PERFORM pg_advisory_xact_lock(73429,91247); END IF; RETURN NEW; END $$",
      ),
    );
    await checked(() =>
      gate.query(
        'CREATE TRIGGER reset_crash_wait BEFORE INSERT ON "World" FOR EACH ROW EXECUTE FUNCTION reset_crash_wait()',
      ),
    );
    const before = await fullFootprint(['EngineLease', 'EngineHeartbeat']);
    child = spawnEngine(payload.worldId, signal);
    await checked(() =>
      expect
        .poll(
          async () => {
            const rows = (
              await checked(() =>
                gate.query(
                  "SELECT pid FROM pg_stat_activity WHERE datname=$1 AND pid<>$2 AND wait_event_type='Lock' AND wait_event='advisory' AND $2=ANY(pg_blocking_pids(pid))",
                  [name, blocker],
                ),
              )
            ).rows;
            return rows.length;
          },
          { timeout: 8000 },
        )
        .toBe(1),
    );
    expect(child.child.kill('SIGKILL')).toBe(true);
    await checked(child.stop);
    expect(child.signal === 'SIGKILL' || (typeof child.code === 'number' && child.code !== 0)).toBe(true);
    await checked(() =>
      expect.poll(() => fullFootprint(['EngineLease', 'EngineHeartbeat']), { timeout: 5000 }).toBe(before),
    );
    expect(await eventFor(payload)).toMatchObject({ status: 'PENDING', sequence: null, tick: null, result: null });
    expect(await checked(() => db.world.count({ where: { id: crashPlanned } }))).toBe(0);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const work of [
      async () => {
        if (child) await child.stop();
      },
      () => gate.query('SELECT pg_advisory_unlock(73429,91247)'),
      () => gate.query('DROP TRIGGER IF EXISTS reset_crash_wait ON "World"'),
      () => gate.query('DROP FUNCTION IF EXISTS reset_crash_wait()'),
    ])
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
  }
  if (failures.length) throw new AggregateError(failures, '실제 crash와 자기 trigger·자식 정리 실패');
});
it('AC-M3-04 D2 crash 뒤 실제 새 --world 엔진은 같은 UUID·시드를 한 번만 적용한다', async (signal) => {
  if (!crashPayload) throw new Error('자기 crash 요청이 필요합니다.');
  const payload = crashPayload,
    before = adminResetPayloadSchema.parse((await eventFor(payload)).payload),
    count = await checked(() => db.world.count());
  const child = spawnEngine(payload.worldId, signal),
    failures: unknown[] = [];
  try {
    await checked(() => expect.poll(async () => (await eventFor(payload)).status, { timeout: 23000 }).toBe('APPLIED'));
    await checked(child.stop);
    expect(child.code).toBe(0);
    const event = await eventFor(payload),
      source = await checked(() => db.world.findUniqueOrThrow({ where: { id: payload.worldId } })),
      targetWorld = await checked(() => db.world.findUniqueOrThrow({ where: { id: crashPlanned } }));
    checkedResetTarget(source, event, targetWorld);
    expect(adminResetPayloadSchema.parse(event.payload)).toEqual(before);
    expect(await checked(() => db.world.count())).toBe(count + 1);
    expect(targetWorld.status).toBe('PREOPEN');
    expect(
      await checked(() => db.auditLog.count({ where: { inputEventId: event.id, action: 'world.reset.applied' } })),
    ).toBe(1);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await child.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '실제 재시작과 자기 엔진 정리 실패');
});
it('AC-M3-04 D3 초기화로 만든 정식 월드를 다시 초기화해도 같은 시드·초기 해시가 같다', async (signal) => {
  if (!resetOwner || !resetPayload || !newWorldId) throw new Error('앞선 정식 초기화 결과가 필요합니다.');
  const source = await checked(() => db.world.findUniqueOrThrow({ where: { id: newWorldId } }));
  const fixedSeed = adminResetPayloadSchema.parse((await eventFor(resetPayload)).payload).effectiveSeed;
  const payload = { ...input(resetOwner, source), seed: fixedSeed };
  await accepted(resetOwner, payload, signal);
  await apply(source.id, signal);
  const event = await eventFor(payload),
    next = await checked(() =>
      db.world.findUniqueOrThrow({ where: { id: adminResetPayloadSchema.parse(event.payload).plannedNewWorldId } }),
    );
  checkedResetTarget(await checked(() => db.world.findUniqueOrThrow({ where: { id: source.id } })), event, next);
  expect(next.initialStateHash).toBe(source.initialStateHash);
  expect(next.seed).toBe(fixedSeed);
  expect(next.status).toBe('PREOPEN');
  expect(await checked(() => db.general.count({ where: { worldId: next.id, userId: { not: null } } }))).toBe(0);
  expect(replayToEnd(await checked(() => exportReplay(db, source.id)))).toMatchObject({ reason: 'ADMIN_RESET' });
});
it('AC-M3-04 D3 초기화 종료 뒤 게임 쓰기·재개는 거부하고 기존 사람·30칸은 그대로 읽는다', async (signal) => {
  if (!resetOwner || !resetPayload) throw new Error('앞선 정식 사람 고정물이 필요합니다.');
  const worldId = resetPayload.worldId,
    owner = resetOwner,
    other = await actor(),
    before = await fullFootprint();
  const slots = Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {} }));
  const results = await Promise.allSettled([
    call('turns.set', { worldId, revision: 0, slots }, signal, owner),
    call(
      'general.create',
      {
        worldId,
        name: '종료뒤생성',
        portraitId: null,
        leadership: 55,
        strength: 55,
        intel: 55,
        politics: 55,
        charm: 55,
      },
      signal,
      other,
    ),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    expect(result.value.status).toBe(412);
  }
  const current = await checked(() =>
    db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: owner.id } } }),
  );
  expect(await checked(() => db.generalTurn.count({ where: { worldId, generalId: current.id } }))).toBe(30);
  expect(await fullFootprint()).toBe(before);
  const stable = await fullFootprint();
  await expect(controlClock(db, worldId, 'resume')).rejects.toThrow();
  expect(await fullFootprint()).toBe(stable);
});
it('AC-M3-04 D3 접수된 일반 입력은 초기화 뒤 WORLD_CLOSED만 기록하고 원본 게임을 바꾸지 않는다', async (signal) => {
  const owner = await actor(),
    person = await actor('USER'),
    source = await world(),
    failures: unknown[] = [];
  await checked(() => controlClock(db, source.id, 'resume'));
  const pendingRequest = call(
    'general.create',
    {
      worldId: source.id,
      name: '대기장수',
      portraitId: null,
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
    },
    signal,
    person,
  );
  const settlement = Promise.allSettled([pendingRequest]);
  try {
    await checked(() =>
      expect
        .poll(
          () =>
            checked(() =>
              db.inputEvent.count({
                where: { worldId: source.id, userId: person.id, kind: 'general.create', status: 'PENDING' },
              }),
            ),
          { timeout: 5000 },
        )
        .toBe(1),
    );
    await checked(() => controlClock(db, source.id, 'pause'));
    const paused = await checked(() => db.world.findUniqueOrThrow({ where: { id: source.id } })),
      payload = input(owner, paused);
    await accepted(owner, payload, signal);
    const before = hashState(await checked(() => loadReplayState(db, source.id)));
    await apply(source.id, signal);
    expect(hashState(await checked(() => loadReplayState(db, source.id)))).toBe(before);
    const queued = await checked(() =>
      db.inputEvent.findFirstOrThrow({ where: { worldId: source.id, userId: person.id, kind: 'general.create' } }),
    );
    expect(queued).toMatchObject({ status: 'REJECTED', result: { code: 'WORLD_CLOSED' } });
    expect(await checked(() => db.general.count({ where: { worldId: source.id, userId: person.id } }))).toBe(0);
    expect(replayToEnd(await checked(() => exportReplay(db, source.id)))).toMatchObject({ reason: 'ADMIN_RESET' });
  } catch (error) {
    failures.push(error);
  }
  for (const result of await settlement) if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, '일반 입력 응답과 종료 뒤 정리 실패');
});

// AC-INT-18D/AC-M3-04: dedicated formal-world contract tests, not full-season acceptance.
const cityResetFeatures = [
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'five-stats',
  'operational-map',
  'personnel',
  'policy',
];
type CityResetWorld = Awaited<ReturnType<typeof world>>;
type CreateReceipt = {
  userId: string;
  requestId: string;
  idempotencyKey: string;
  status: 'PENDING' | 'DONE' | 'FAILED';
  worldId: string | null;
  error: unknown;
};
async function assertFreshCityResetWorld(id: string) {
  const row = await checked(() => db.world.findUniqueOrThrow({ where: { id } }));
  const origin: unknown = row.replayOrigin;
  checkReplayOrigin(origin);
  if (origin.version !== 3) throw new Error('도시 초기화의 형식3 원생성이 필요합니다.');
  expect(row).toMatchObject({ status: 'PREOPEN', clockTick: 0, clockRevision: 0, startedAt: null, endedAt: null });
  expect(row.ruleFeatures).toEqual(cityResetFeatures);
  expect(origin.initial.ruleFeatures).toEqual(cityResetFeatures);
  expect(row.initialStateHash).toBe(hashState(origin.initial));
  expect(origin.resourceHash).toBe(resourceHashV3(origin));
  expect(Object.hasOwn(origin.initial, 'cityResources')).toBe(false);
  expect(origin.initial.nations).toHaveLength(21);
  expect(origin.initial.generals).toHaveLength(491);
  expect(origin.initial.cities.filter((city) => city.kind === 'CITY')).toHaveLength(53);
  expect(origin.initial.cities.filter((city) => city.kind === 'PASS')).toHaveLength(8);
  const empty = emptyCityResourcesState(toWorldState(origin.initial)),
    loaded = await checked(() => db.$transaction((tx) => loadReplayState(tx, id)));
  expect(Object.keys(empty.cities)).toHaveLength(61);
  expect(row.cityResourcesState).toEqual(empty);
  expect(loaded).toEqual(initialReplayStateWithRegistry(origin.initial, ruleRegistry, origin.featureData));
  expect(loaded.state.cityResources).toEqual(empty);
  expect(await checked(() => db.nation.count({ where: { worldId: id } }))).toBe(21);
  expect(await checked(() => db.general.count({ where: { worldId: id, userId: null } }))).toBe(491);
  expect(await checked(() => db.general.count({ where: { worldId: id, userId: { not: null } } }))).toBe(0);
  expect(await checked(() => db.generalTurn.count({ where: { worldId: id } }))).toBe(491 * 30);
  const archive = await checked(() => exportReplay(db, id));
  expect(archive.origin).toEqual(origin);
  return row;
}
async function pauseFreshCityWorld(id: string) {
  await checked(() => controlClock(db, id, 'start'));
  await checked(() => controlClock(db, id, 'pause'));
  return checked(() => db.world.findUniqueOrThrow({ where: { id } }));
}
async function cityReset(owner: Actor, source: CityResetWorld, signal: AbortSignal) {
  const payload = input(owner, source),
    receipt = await accepted(owner, payload, signal);
  expect(await apply(source.id, signal)).toMatchObject({ status: 'ENDED' });
  const event = await eventFor(payload),
    ended = await checked(() => db.world.findUniqueOrThrow({ where: { id: source.id } })),
    next = await assertFreshCityResetWorld(receipt.plannedNewWorldId);
  expect(event.status).toBe('APPLIED');
  const applied = checkedResetTarget(ended, event, next);
  const oldOrigin: unknown = source.replayOrigin,
    nextOrigin: unknown = next.replayOrigin;
  checkReplayOrigin(oldOrigin);
  checkReplayOrigin(nextOrigin);
  if (oldOrigin.version !== 3 || nextOrigin.version !== 3) throw new Error('도시 초기화 원생성 형식이 다릅니다.');
  expect(nextOrigin.featureData).toEqual(oldOrigin.featureData);
  expect(nextOrigin.resourceHash).toBe(oldOrigin.resourceHash);
  expect(nextOrigin.initial.operationalMap).toEqual(oldOrigin.initial.operationalMap);
  expect(nextOrigin.initial.statRules).toEqual(oldOrigin.initial.statRules);
  const identities = (initial: typeof nextOrigin.initial) =>
    initial.generals.map((general) => ({
      id: general.id,
      name: general.name,
      leadership: general.leadership,
      strength: general.strength,
      intel: general.intel,
      politics: general.politics,
      charm: general.charm,
    }));
  expect(identities(nextOrigin.initial)).toEqual(identities(oldOrigin.initial));
  expect(next.ruleFeatures).toEqual(source.ruleFeatures);
  expect(next.seed).toBe(adminResetPayloadSchema.parse(event.payload).effectiveSeed);
  const oldArchive = await checked(() => exportReplay(db, source.id));
  expect(replayToEnd(oldArchive)).toMatchObject({ reason: 'ADMIN_RESET', winnerNationId: null });
  expect(replayToEnd(JSON.parse(JSON.stringify(oldArchive)))).toEqual(replayToEnd(oldArchive));
  const first = await call('admin.world.resetRequest', query(payload), signal, owner),
    count = await checked(() => db.world.count());
  expect(first.status).toBe(200);
  expect(first.data).toMatchObject({ status: 'APPLIED', plannedNewWorldId: next.id });
  expect(await request(owner, payload, signal)).toEqual(first);
  expect(await apply(source.id, signal)).toMatchObject({ status: 'ENDED' });
  expect(await checked(() => db.world.count())).toBe(count);
  await assertNoLiveLease(source.id);
  return { source: ended, next, event, applied };
}
let cityOwner: Actor | undefined,
  cliCitySource: CityResetWorld | undefined,
  peerCityWorld: CityResetWorld | undefined,
  lastCityTarget: CityResetWorld | undefined;
it('AC-INT-18D AC-M3-04 실제 게시 CLI의 도시 판과 두 월드 사람30칸·첫 세수를 준비한다', async (signal) => {
  cityOwner = await actor();
  const result = await hook(
    '도시 게시 CLI',
    async (deadlineSignal) => {
      const cliSignal = AbortSignal.any([signal, deadlineSignal]),
        cli = spawnResetTool(
          [
            fileURLToPath(new URL('../apps/engine/src/cli/createWorld.ts', import.meta.url)),
            '--published',
            '--scenario',
            'integration191',
            '--map',
            'integration',
            '--stat-rules',
            'five-stats',
            '--portrait-map',
            '191-map',
            '--rule-features',
            cityResetFeatures.join(','),
            '--seed',
            'city-reset-cli-source',
            '--turn-term',
            '30',
            '--end-year',
            '200',
            '--name',
            '도시 초기화 CLI 정식191',
          ],
          cliSignal,
        ),
        output: string[] = [];
      cli.child.stdout!.on('data', (chunk) => output.push(String(chunk)));
      await checked(() => cli.done, cliSignal);
      await checked(cli.stop, signal);
      expect(cli).toMatchObject({ closed: true, stdoutEnded: true, stderrEnded: true, code: 0, signal: null });
      return JSON.parse(output.join('').trim()) as { worldId: string; stateHash: string };
    },
    true,
    20000,
  );
  signal.throwIfAborted();
  const cliInitial = await assertFreshCityResetWorld(result.worldId);
  expect(cliInitial.initialStateHash).toBe(result.stateHash);
  expect(
    await checked(() =>
      db.auditLog.count({ where: { worldId: result.worldId, actorKind: 'CLI', action: 'world.create.applied' } }),
    ),
  ).toBe(1);
  expect(await checked(() => db.worldCreateRequest.count({ where: { plannedWorldId: result.worldId } }))).toBe(0);
  cliCitySource = await pauseFreshCityWorld(result.worldId);
  const initial = await checked(() =>
    loadInitialWorldFromDb(db, {
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'city-reset-peer-source',
    }),
  );
  initial.ruleFeatures = [...cityResetFeatures];
  const peer = await checked(() =>
    saveInitialWorld(db, initial, {
      name: '도시 초기화 격리 정식191',
      turnTermMinutes: 30,
      endYear: 200,
      ruleFeatures: [...cityResetFeatures],
    }),
  );
  await assertFreshCityResetWorld(peer.worldId);
  peerCityWorld = await pauseFreshCityWorld(peer.worldId);
  for (const [index, row] of [cliCitySource, peerCityWorld].entries())
    await human(row.id, cityOwner, signal, index + 10);
  const peerBefore = hashState(await checked(() => db.$transaction((tx) => loadReplayState(tx, peer.worldId))));
  await checked(() => controlClock(db, cliCitySource!.id, 'resume'));
  await withLease(cliCitySource.id, signal, (lease, signal) =>
    new TurnLoop(db, lease).advanceTo(TICKS_PER_MONTH, signal),
  );
  await checked(() => controlClock(db, cliCitySource!.id, 'pause'));
  cliCitySource = await checked(() => db.world.findUniqueOrThrow({ where: { id: cliCitySource!.id } }));
  const settled = await checked(() => db.$transaction((tx) => loadReplayState(tx, cliCitySource!.id)));
  expect(Object.values(settled.state.cityResources!.cities).some((city) => city.gold > 0 || city.rice > 0)).toBe(true);
  expect(hashState(await checked(() => db.$transaction((tx) => loadReplayState(tx, peer.worldId))))).toBe(peerBefore);
  for (const row of [cliCitySource, peerCityWorld]) {
    const person = await checked(() =>
      db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId: row.id, userId: cityOwner!.id } } }),
    );
    expect(await checked(() => db.generalTurn.count({ where: { worldId: row.id, generalId: person.id } }))).toBe(30);
  }
}, 120000);
it('AC-INT-18D AC-M3-04 도시 초기화는 원본 세수·사람·30칸과 타월드를 보존하고 빈61원장만 만든다', async (signal) => {
  if (!cityOwner || !cliCitySource || !peerCityWorld) throw new Error('앞선 도시 정식 두 월드가 필요합니다.');
  const started = performance.now(),
    phase = (name: string) =>
      console.info(
        JSON.stringify({ event: 'city-reset-preservation-phase', phase: name, elapsedMs: performance.now() - started }),
      );
  phase('started');
  const payload = input(cityOwner, cliCitySource),
    receipt = await accepted(cityOwner, payload, signal),
    event = await eventFor(payload);
  phase('admitted');
  const before = await existingRows([cliCitySource.id, peerCityWorld.id], cliCitySource.id, event.id),
    ledger = structuredClone(cliCitySource.cityResourcesState);
  phase('before-snapshot');
  expect(await apply(cliCitySource.id, signal)).toMatchObject({ status: 'ENDED' });
  phase('applied');
  const applied = await eventFor(payload),
    ended = await checked(() => db.world.findUniqueOrThrow({ where: { id: cliCitySource!.id } }));
  lastCityTarget = await assertFreshCityResetWorld(receipt.plannedNewWorldId);
  phase('fresh-target');
  checkedResetTarget(ended, applied, lastCityTarget);
  expect(ended.cityResourcesState).toEqual(ledger);
  expect(await existingRows([cliCitySource.id, peerCityWorld.id], cliCitySource.id, event.id)).toBe(before);
  phase('after-snapshot');
  const sourceArchive = await checked(() => exportReplay(db, cliCitySource!.id)),
    replayed = replayToEnd(sourceArchive);
  expect(replayed).toMatchObject({ reason: 'ADMIN_RESET', winnerNationId: null });
  expect(replayToEnd(JSON.parse(JSON.stringify(sourceArchive)))).toEqual(replayed);
  phase('replayed');
  const count = await checked(() => db.world.count()),
    same = await call('admin.world.resetRequest', query(payload), signal, cityOwner);
  expect(same.data).toMatchObject({ status: 'APPLIED', plannedNewWorldId: lastCityTarget.id });
  expect(await request(cityOwner, payload, signal)).toEqual(same);
  await apply(cliCitySource.id, signal);
  expect(await checked(() => db.world.count())).toBe(count);
  phase('idempotency-verified');
});
it('AC-INT-18D AC-M3-04 실제 생성 DONE과 초기화 APPLIED 출처는 같은 도시 기능·게시 자료로 다시 초기화한다', async (signal) => {
  if (!cityOwner) throw new Error('도시 초기화 관리자가 필요합니다.');
  const key = randomUUID(),
    response = await call<CreateReceipt>(
      'admin.world.create',
      {
        expectedUserId: cityOwner.id,
        idempotencyKey: key,
        name: '도시 DONE 원생성',
        scenarioKey: 'integration191',
        mapKey: 'integration',
        statRulesKey: 'five-stats',
        portraitMapKey: '191-map',
        ruleFeatures: cityResetFeatures.filter((feature) => !['five-stats', 'operational-map'].includes(feature)),
        seed: 'city-reset-done-source',
        turnTermMinutes: 30,
        endYear: 200,
      },
      signal,
      cityOwner,
    );
  expect(response.status).toBe(200);
  expect(response.data).toMatchObject({ status: 'PENDING', userId: cityOwner.id, idempotencyKey: key });
  expect(await checked(() => processWorldCreateRequest(db, signal))).toBe(true);
  const requestRow = await checked(() =>
    db.worldCreateRequest.findUniqueOrThrow({
      where: { requestedBy_idempotencyKey: { requestedBy: cityOwner!.id, idempotencyKey: key } },
    }),
  );
  expect(requestRow.status).toBe('DONE');
  if (!requestRow.worldId) throw new Error('실제 DONE 월드가 필요합니다.');
  await assertFreshCityResetWorld(requestRow.worldId);
  const first = await cityReset(cityOwner, await pauseFreshCityWorld(requestRow.worldId), signal),
    second = await cityReset(cityOwner, await pauseFreshCityWorld(first.next.id), signal);
  expect(first.applied.resources).toEqual(second.applied.resources);
  const createRefs = adminResetResourcesSchema.parse(
    adminResetResourceSchema
      .array()
      .parse((requestRow.resolution as { resources?: unknown }).resources)
      .sort((a, b) => a.kind.localeCompare(b.kind)),
  );
  expect(first.applied.resources).toEqual(createRefs);
  lastCityTarget = second.next;
});
it('AC-INT-18D AC-M3-04 새 도시 원장 NULL은 초기화 전체를 롤백하고 구판은 SQLNULL을 유지한다', async (signal) => {
  if (!cityOwner || !lastCityTarget) throw new Error('실제 도시 초기화 대상이 필요합니다.');
  const source = await pauseFreshCityWorld(lastCityTarget.id),
    payload = input(cityOwner, source),
    receipt = await accepted(cityOwner, payload, signal);
  await withLease(source.id, signal, async (lease, signal) => {
    const before = await fullFootprint(['EngineLease']);
    await expect(
      new TurnLoop(db, lease, {
        beforeCommit: async (tx) => {
          await tx.$executeRaw`UPDATE "World" SET "cityResourcesState"=NULL WHERE id=${receipt.plannedNewWorldId}`;
        },
      }).poll(signal),
    ).rejects.toThrow();
    expect(await fullFootprint(['EngineLease'])).toBe(before);
    expect((await eventFor(payload)).status).toBe('PENDING');
    expect(await checked(() => db.world.count({ where: { id: receipt.plannedNewWorldId } }))).toBe(0);
    expect((await checked(() => db.world.findUniqueOrThrow({ where: { id: source.id } }))).cityResourcesState).toEqual(
      source.cityResourcesState,
    );
  });
  await assertNoLiveLease(source.id);
  const old = await world({ ruleFeatures: ['policy'] }),
    oldPayload = input(cityOwner, old),
    oldReceipt = await accepted(cityOwner, oldPayload, signal);
  expect(await apply(old.id, signal)).toMatchObject({ status: 'ENDED' });
  const legacy = await checked(() => db.world.findUniqueOrThrow({ where: { id: oldReceipt.plannedNewWorldId } }));
  expect(legacy.ruleFeatures).not.toContain('city-resources-v1');
  expect(legacy.cityResourcesState).toBeNull();
  expect(
    Object.hasOwn(
      (await checked(() => db.$transaction((tx) => loadReplayState(tx, legacy.id)))).state,
      'cityResources',
    ),
  ).toBe(false);
});

afterAll(async () => {
  const deadline = Date.now() + 110000;
  let connections: number | undefined,
    dropped = false;
  const adminClosed = await cleanupWithReservedClose(
    async (signal) => {
      for (const c of controllers) if (c.signal !== signal) c.abort();
      await Promise.allSettled(children.map((child) => cleanupAttempt(child.stop)));
      await cleanupAttempt(settle, 50000, false);
      await Promise.allSettled(
        [() => app?.close(), () => gate.end(), () => db.$disconnect()].map((close) =>
          cleanupAttempt(async () => close()),
        ),
      );
      await cleanupAttempt(() => childScope.close());
      if (
        children.some((child) => !child.closed || !child.stdoutEnded || !child.stderrEnded) ||
        childScope.snapshot().state !== 'closed'
      )
        fail(new Error('실제 엔진 자식 close/streams 미확인: DB 보존'));
      if (pending.size) fail(new Error('정착하지 않은 원 작업: DB 보존'));
      for (const secret of secrets)
        if (secret && logs.join('\n').includes(secret)) fail(new Error('비공개 값 로그 노출'));
      if (ownership.creationAttempted) {
        if (!ownership.creationAcknowledged || !ownership.initialOid)
          fail(new Error('CREATE 응답 미확정: 자기 DB 보존'));
        await auditCreatedDatabase(admin, name, ownership, databaseAudit, signal);
        connections = databaseAudit.connections ?? undefined;
        if (
          !failed &&
          !errors.length &&
          !pending.size &&
          !signal.aborted &&
          Date.now() + 30000 < deadline &&
          ownership.creationAcknowledged &&
          oid &&
          databaseAudit.verified &&
          databaseAudit.identity === 'matched'
        ) {
          await dropExactOwnedDatabase(admin, name, oid, signal);
          expect(
            (await checked(() => admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name]), signal)).rows,
          ).toHaveLength(0);
          dropped = true;
          databaseAudit.preserved = false;
        }
      }
    },
    () => admin.end(),
  );
  console.info(
    JSON.stringify({
      event: 'admin-reset-d1-cleanup',
      name,
      oid,
      connections,
      dropped,
      adminClosed,
      ownership,
      databaseAudit,
      childScopeState: childScope.snapshot().state,
      children: children.map(({ closed, stdoutEnded, stderrEnded }) => ({ closed, stdoutEnded, stderrEnded })),
      suiteFailed: failed,
      pendingOperations: pending.size,
      errors: errors.length,
    }),
  );
  if (errors.length) throw new AggregateError([...new Set(errors)], '초기화 준비 본문과 자기 자원 정리 실패');
}, 120000);
