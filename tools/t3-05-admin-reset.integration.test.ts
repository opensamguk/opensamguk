import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { beforeAll, afterAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { initializeResources } from './init-resources';
import { initializeIntegrationResources } from './integration-resources';
import { testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';

// RESET-D1 접수 전용이다. 실제 소비·원본 종료·새 월드·재생은 D2/D3에서 검증한다.
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
async function world() {
  const state = await checked(() =>
    loadInitialWorldFromDb(db, {
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: randomUUID(),
    }),
  );
  expect(state.nations).toHaveLength(21);
  expect(state.generals).toHaveLength(491);
  const saved = await checked(() =>
    saveInitialWorld(db, state, { name: '초기화 접수 보존', turnTermMinutes: 30, endYear: 200 }),
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
async function call(path: string, data: unknown, signal: AbortSignal, owner?: Actor) {
  return track(async () => {
    signal.throwIfAborted();
    const mutation = path === 'admin.world.requestReset',
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
      result?: { data: Receipt };
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
    expect(result.message).toBe('월드 초기화 요청을 처리하지 못했습니다.');
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
afterAll(async () => {
  const deadline = Date.now() + 110000;
  let connections: number | undefined,
    dropped = false;
  const adminClosed = await cleanupWithReservedClose(
    async (signal) => {
      for (const c of controllers) if (c.signal !== signal) c.abort();
      await cleanupAttempt(settle, 50000, false);
      await Promise.allSettled(
        [() => app?.close(), () => gate.end(), () => db.$disconnect()].map((close) =>
          cleanupAttempt(async () => close()),
        ),
      );
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
      suiteFailed: failed,
      pendingOperations: pending.size,
      errors: errors.length,
    }),
  );
  if (errors.length) throw new AggregateError([...new Set(errors)], '초기화 준비 본문과 자기 자원 정리 실패');
}, 120000);
