import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { appRouter } from '../apps/server/src/router';
import type { Context } from '../apps/server/src/context';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { createRateLimiter } from '../apps/server/src/security/rateLimit';
import { publicMapConfig } from '../packages/shared/src/index';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { initializeResources } from './init-resources';
import { initializeIntegrationResources } from './integration-resources';
import { initializeSan10Resources } from './san10-resources';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { processWorldCreateRequest } from '../apps/engine/src/admin/createRequests';
import { stopOwnedChild } from '../apps/engine/src/process-lifecycle';
import { testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';

type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Pg;
};
if (!process.env.TEST_DATABASE_URL) throw new Error('전용 시험 DB가 필요합니다.');
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(source.hostname)) throw new Error('loopback 시험 서버가 필요합니다.');
for (const key of source.searchParams.keys())
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    throw new Error('접속 대상 질의 인자는 쓸 수 없습니다.');
const name = 't305_create_' + randomUUID().replaceAll('-', '') + '_test';
const target = new URL(source),
  adminUrl = new URL(source);
target.pathname = '/' + name;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href }),
  gate = new Client({ connectionString: target.href }),
  db = createDb(target.href);
const origin = 'http://127.0.0.1:5173';
const pending = new Set<Promise<unknown>>(),
  errors: unknown[] = [],
  logs: string[] = [],
  secrets = new Set<string>([target.href, target.password, decodeURIComponent(target.password)]);
const apps = new Set<Awaited<ReturnType<typeof buildServer>>>(),
  children: OwnedChild[] = [],
  oldWorlds: string[] = [];
const crashUrl = new URL(target);
const crashName = 't305_create_crash_' + randomUUID().replaceAll('-', '') + '_test';
crashUrl.pathname = '/' + crashName;
const crash = {
  name: crashName,
  url: crashUrl,
  db: createDb(crashUrl.href),
  gate: new Client({ connectionString: crashUrl.href }),
  created: false,
  oid: undefined as string | undefined,
  connections: undefined as number | undefined,
  dropped: false,
  owner: undefined as Actor | undefined,
  address: '',
  requestId: '',
  plannedWorldId: '',
  key: '',
};
secrets.add(crashUrl.href);
let oid: string | undefined,
  address = '',
  passwordHash = '';
type Actor = { id: string; email: string; cookie: string; sessionId: string };
let actor: Actor, peer: Actor, firstRequest: Receipt;
type Receipt = {
  userId: string;
  requestId: string;
  idempotencyKey: string;
  status: 'PENDING' | 'DONE' | 'FAILED';
  worldId: string | null;
  error: null | { code: string; message: string };
};
type Response = { status: number; code: string | undefined; data: Receipt | undefined; raw: string };
type OwnedChild = {
  child: ChildProcess;
  closed: Promise<void>;
  code: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  stdoutEnded: boolean;
  stderrEnded: boolean;
  spawnError?: unknown;
  closedAt?: string;
  output: string;
  stopping?: Promise<void>;
  purpose: string;
};
function track<T>(work: () => Promise<T>) {
  const promise = Promise.resolve().then(work);
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    (error) => {
      errors.push(error);
      pending.delete(promise);
    },
  );
  return promise;
}

const operationSignals = new AsyncLocalStorage<AbortSignal>();
function suiteGuard(record: (error: unknown) => void) {
  let failed = false;
  const fail = (error: unknown) => {
    failed = true;
    record(error);
  };
  return {
    get failed() {
      return failed;
    },
    fail,
    async hook<T>(
      label: string,
      work: (signal: AbortSignal) => Promise<T>,
      tracker: <U>(work: () => Promise<U>) => Promise<U> = (work) => Promise.resolve().then(work),
      budgetMs = 110_000,
    ) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const original = tracker(() => operationSignals.run(controller.signal, () => work(controller.signal)));
      try {
        return await Promise.race([
          original,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error('자기 ' + label + ' hook 내부 기한 초과: DB 보존');
              fail(error);
              controller.abort(error);
              reject(error);
            }, budgetMs);
          }),
        ]);
      } catch (error) {
        fail(error);
        controller.abort(error);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
const suite = suiteGuard((error) => errors.push(error));
async function checked<T>(work: () => Promise<T>, signal = operationSignals.getStore()): Promise<T> {
  signal?.throwIfAborted();
  const result = await work();
  signal?.throwIfAborted();
  return result;
}
async function cleanupAttempt(work: () => Promise<unknown>, budgetMs = 10_000, tracked = true) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const original = tracked ? track(work) : Promise.resolve().then(work);
  try {
    await Promise.race([
      original,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('자기 cleanup 정착 기한 초과: DB 보존')), budgetMs);
      }),
    ]);
    return true;
  } catch (error) {
    suite.fail(error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function settle() {
  while (pending.size) await Promise.allSettled([...pending]);
}
async function concurrent<T>(work: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(work),
    failures = results.filter((row) => row.status === 'rejected').map((row) => row.reason);
  if (failures.length) throw new AggregateError(failures, '동시 작업 정착 실패');
  return results.map((row) => (row as PromiseFulfilledResult<T>).value);
}
function it(title: string, work: (signal: AbortSignal) => Promise<void>, timeout = 30_000) {
  test(
    title,
    ({ onTestFailed }) => {
      const controller = new AbortController();
      onTestFailed(() => {
        controller.abort();
        suite.fail(new Error('실패한 자기 생성 DB를 보존합니다.'));
      });
      const promise = track(() => operationSignals.run(controller.signal, () => work(controller.signal)));
      void promise.then(
        () => controller.abort(),
        () => controller.abort(),
      );
      return promise;
    },
    timeout,
  );
}
beforeEach(settle);
async function cleanupBoth(work: () => Promise<void>, actions: Array<() => Promise<unknown>>) {
  const failures: unknown[] = [];
  try {
    await work();
  } catch (error) {
    failures.push(error);
  }
  for (const action of actions)
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length) throw new AggregateError(failures, '본문과 자기 자원 정리 실패');
}
async function start(options: Partial<Parameters<typeof buildServer>[0]> = {}) {
  operationSignals.getStore()?.throwIfAborted();
  const app = await buildServer({
    db,
    publicOrigin: origin,
    emailVerificationRequired: true,
    logStream: {
      write(chunk: string) {
        logs.push(chunk);
      },
    },
    ...options,
  });
  apps.add(app);
  await checked(async () => app.ready());
  const failures: unknown[] = [];
  for (let attempt = 0; attempt < 16; attempt++)
    try {
      return await checked(() => app.listen({ host: '127.0.0.1', port: randomInt(20_000, 50_000) }));
    } catch (error) {
      if (app.server.listening || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      failures.push(error);
    }
  throw new AggregateError(failures, '자기 listener의 유한 bind 실패');
}
async function user(
  role: 'USER' | 'ADMIN' = 'ADMIN',
  status: 'ACTIVE' | 'SANCTIONED' = 'ACTIVE',
  verified = true,
  database = db,
): Promise<Actor> {
  const email = randomUUID() + '@example.test',
    sid = newSession(Date.now());
  secrets.add(email);
  secrets.add(sid.token);
  const row = await checked(() =>
    database.user.create({
      data: { email, passwordHash, role, status, emailVerifiedAt: verified ? new Date() : null },
    }),
  );
  await checked(() => database.session.create({ data: { id: sid.id, userId: row.id, expiresAt: sid.expiresAt } }));
  return { id: row.id, email, cookie: 'sid=' + sid.token, sessionId: sid.id };
}
function input(owner: Actor, extra: Record<string, unknown> = {}) {
  return {
    expectedUserId: owner.id,
    idempotencyKey: randomUUID(),
    name: '관리 생성 정식191',
    scenarioKey: 'integration191',
    mapKey: 'integration',
    statRulesKey: 'five-stats',
    portraitMapKey: '191-map',
    turnTermMinutes: 60,
    endYear: 300,
    ...extra,
  };
}
async function call(
  path: string,
  data: unknown,
  signal: AbortSignal,
  owner?: Actor,
  mutation = false,
  base = address,
): Promise<Response> {
  return track(async () => {
    signal.throwIfAborted();
    const encoded = JSON.stringify({ 0: data });
    const response = await fetch(
      base + '/trpc/' + path + '?batch=1' + (mutation ? '' : '&input=' + encodeURIComponent(encoded)),
      {
        method: mutation ? 'POST' : 'GET',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
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
    const [item] = JSON.parse(raw) as Array<{ result?: { data: Receipt }; error?: { data: { code: string } } }>;
    return { status: response.status, data: item?.result?.data, code: item?.error?.data.code, raw };
  });
}
const create = (owner: Actor, data: unknown, signal: AbortSignal, base = address) =>
  call('admin.world.create', data, signal, owner, true, base);
const status = (owner: Actor, key: string, signal: AbortSignal) =>
  call('admin.world.createStatus', { expectedUserId: owner.id, idempotencyKey: key }, signal, owner);
async function accepted(owner: Actor, signal: AbortSignal, extra: Record<string, unknown> = {}) {
  const payload = input(owner, extra),
    result = await create(owner, payload, signal);
  expect(result.status).toBe(200);
  if (!result.data) throw new Error('실제 생성 접수가 필요합니다.');
  return { payload, receipt: result.data };
}
async function row(id: string) {
  return checked(() => db.worldCreateRequest.findUniqueOrThrow({ where: { id } }));
}
async function processOne(signal: AbortSignal) {
  signal.throwIfAborted();
  return processWorldCreateRequest(db, signal);
}
async function footprint(exclude: readonly string[] = [], onlyWorld?: string, signal = operationSignals.getStore()) {
  const tables = await checked(
      () => gate.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"),
      signal,
    ),
    hash = createHash('sha256');
  for (const { tablename } of tables.rows) {
    signal?.throwIfAborted();
    if (typeof tablename !== 'string') throw new Error('자기 표 이름이 다릅니다.');
    if (exclude.includes(tablename)) continue;
    let where = '',
      values: unknown[] = [];
    if (onlyWorld) {
      if (tablename === 'World') {
        where = ' WHERE id=$1';
        values = [onlyWorld];
      } else {
        const columns = await checked(
          () =>
            gate.query(
              "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='worldId'",
              [tablename],
            ),
          signal,
        );
        if (!columns.rows.length) continue;
        where = ' WHERE "worldId"=$1';
        values = [onlyWorld];
      }
    }
    const quoted = '"' + tablename.replaceAll('"', '""') + '"',
      rows = await checked(
        () =>
          gate.query(
            "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM " +
              quoted +
              ' t' +
              where,
            values,
          ),
        signal,
      );
    hash.update(tablename + '\n' + String(rows.rows[0]!.body) + '\n');
  }
  return hash.digest('hex');
}
const oldFootprints = async (signal = operationSignals.getStore()) => {
  const hashes: string[] = [];
  for (const worldId of oldWorlds) {
    signal?.throwIfAborted();
    hashes.push(await footprint(['EngineLease', 'EngineHeartbeat'], worldId, signal));
  }
  return hashes;
};
async function noPrivate(raw: string) {
  for (const value of secrets) if (value) expect(raw.includes(value), '원문 비공개 값 없음').toBe(false);
}
async function auditCount(action: string, requestId: string) {
  return db.auditLog.count({
    where: { action, OR: [{ targetId: requestId }, { payload: { path: ['requestId'], equals: requestId } }] },
  });
}
async function scopedFault(table: string, when: string, body: () => Promise<void>) {
  const functionName = 'create_fault_' + randomBytes(6).toString('hex'),
    triggerName = functionName + '_trigger';
  await gate.query(
    'CREATE FUNCTION ' +
      functionName +
      '() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ' +
      when +
      " THEN RAISE EXCEPTION 'private create write refused'; END IF; RETURN NEW; END $$",
  );
  await gate.query(
    'CREATE TRIGGER ' +
      triggerName +
      ' BEFORE INSERT OR UPDATE ON "' +
      table +
      '" FOR EACH ROW EXECUTE FUNCTION ' +
      functionName +
      '()',
  );
  await cleanupBoth(body, [
    () => gate.query('DROP TRIGGER ' + triggerName + ' ON "' + table + '"'),
    () => gate.query('DROP FUNCTION ' + functionName + '()'),
  ]);
}
beforeAll(
  () =>
    suite.hook(
      'setup',
      async (signal) => {
        await checked(() => admin.connect(), signal);
        await checked(() => admin.query('SET statement_timeout=10000'), signal);
        await checked(() => admin.query('SET lock_timeout=10000'), signal);
        expect(
          (await checked(async () => admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name]))).rows,
        ).toHaveLength(0);
        await checked(async () => admin.query('CREATE DATABASE "' + name + '"'));
        oid = String(
          (await checked(async () => admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])))
            .rows[0]!.oid,
        );
        await checked(async () => admin.query('ALTER DATABASE "' + name + '" SET statement_timeout=10000'));
        await checked(async () => gate.connect());
        const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
        for (const migration of (await checked(async () => readdir(migrations)))
          .filter((value) => /^\d{14}_/.test(value))
          .sort()) {
          signal.throwIfAborted();
          await checked(async () =>
            gate.query(await checked(async () => readFile(new URL(migration + '/migration.sql', migrations), 'utf8'))),
          );
        }
        await checked(async () =>
          initializeResources(
            db,
            await checked(async () =>
              readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
            ),
          ),
        );
        await checked(async () => initializeIntegrationResources(db));
        await checked(async () => initializeSan10Resources(db));
        passwordHash = await checked(async () => hashPassword(randomUUID()));
        secrets.add(passwordHash);
        address = await checked(async () => start());
        actor = await checked(async () => user());
        peer = await checked(async () => user());
      },
      track,
    ),
  120_000,
);
afterAll(
  () =>
    suite.hook('cleanup', async (signal) => {
      const deadline = Date.now() + 110_000;
      // Late setup/body/close success never clears suite.failed or authorizes DROP.
      await cleanupAttempt(settle, 70_000, false);
      await Promise.all(
        children.filter((child) => !child.closedAt).map((child) => cleanupAttempt(() => stopChild(child))),
      );
      if (children.some((child) => !child.closedAt || !child.stdoutEnded || !child.stderrEnded))
        suite.fail(new Error('자기 child close/stream 미확인: DB 보존'));
      const closers: Array<() => Promise<unknown>> = [...apps].map((app) => () => app.close());
      closers.push(
        () => gate.end(),
        () => db.$disconnect(),
        () => (crash.created ? crash.gate.end() : Promise.resolve()),
        () => crash.db.$disconnect(),
      );
      await Promise.all(closers.map((close) => cleanupAttempt(close)));
      if (pending.size) suite.fail(new Error('미정착 원 작업이 있어 DB 보존'));
      for (const secret of secrets)
        if (secret && logs.join('\n').includes(secret)) suite.fail(new Error('종료 로그의 비공개 값 노출'));
      const mayDrop = () => {
        if (suite.failed || errors.length || pending.size || signal.aborted) return false;
        if (Date.now() + 30_000 >= deadline) {
          suite.fail(new Error('DROP 전 독립 정리 예산 부족: DB 보존'));
          return false;
        }
        return true;
      };
      let connections: number | undefined,
        dropped = false;
      try {
        if (oid) {
          signal.throwIfAborted();
          ({ connections } = await checked(() => confirmDisconnectedDatabase(admin, name, oid!), signal));
          if (mayDrop()) {
            await checked(() => admin.query('DROP DATABASE "' + name + '"'), signal);
            expect(
              (await checked(() => admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name]), signal)).rows,
            ).toHaveLength(0);
            dropped = true;
          }
        }
      } catch (error) {
        suite.fail(error);
      }

      try {
        if (crash.created) {
          signal.throwIfAborted();
          const identity = await checked(
            () => admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [crash.name]),
            signal,
          );
          if (!crash.oid) {
            suite.fail(new Error('자기 crash DB 최초 OID가 불명하여 보존합니다.'));
            const count = await checked(
              () => admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [crash.name]),
              signal,
            );
            crash.connections = Number(count.rows[0]?.count);
          } else {
            expect(identity.rows).toEqual([{ oid: crash.oid }]);
            ({ connections: crash.connections } = await checked(
              () => confirmDisconnectedDatabase(admin, crash.name, crash.oid!),
              signal,
            ));
            if (mayDrop()) {
              await checked(() => admin.query('DROP DATABASE "' + crash.name + '"'), signal);
              expect(
                (await checked(() => admin.query('SELECT oid FROM pg_database WHERE datname=$1', [crash.name]), signal))
                  .rows,
              ).toHaveLength(0);
              crash.dropped = true;
            }
          }
        }
      } catch (error) {
        suite.fail(error);
      }

      const adminClosed = await cleanupAttempt(() => admin.end());
      console.info(
        JSON.stringify({
          event: 'admin-create-cleanup',
          name,
          oid,
          connections,
          dropped,
          adminClosed,
          suiteFailed: suite.failed,
          hookAborted: signal.aborted,
          pendingOperations: pending.size,

          crashDatabase: {
            name: crash.name,
            created: crash.created,
            oid: crash.oid,
            connections: crash.connections,
            dropped: crash.dropped,
          },
          children: children.map((child) => ({
            closed: !!child.closedAt,
            purpose: child.purpose,
            code: child.code,
            signal: child.signal,
            stdoutEnded: child.stdoutEnded,
            stderrEnded: child.stderrEnded,
          })),

          errors: errors.length,
        }),
      );
      if (errors.length) throw new AggregateError([...new Set(errors)], '생성 접수·엔진·자기 자원 정리 실패');
    }),
  120_000,
);

it('AC-M3-04 정식 두 월드·실제 사람 입력·각30칸과 기존 기록을 준비한다', async (signal) => {
  for (const index of [0, 1]) {
    signal.throwIfAborted();
    const initial = await checked(async () =>
      loadInitialWorldFromDb(db, {
        scenario: 'integration191',
        map: 'integration',
        statRules: 'five-stats',
        portraitMap: '191-map',
        seed: 'create-existing-' + index,
      }),
    );
    expect(initial.nations).toHaveLength(21);
    expect(initial.generals).toHaveLength(491);
    const saved = await checked(async () =>
      saveInitialWorld(db, initial, {
        name: '보존할 정식' + index,
        turnTermMinutes: 60,
        endYear: 300,
      }),
    );
    oldWorlds.push(saved.worldId);
    await checked(async () => controlClock(db, saved.worldId, 'start'));
    const owner = await checked(async () => user('USER'));
    const request = call(
        'general.create',
        {
          worldId: saved.worldId,
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
        true,
      ),
      settled = Promise.allSettled([request]);
    const failures: unknown[] = [];
    try {
      await checked(async () =>
        expect
          .poll(
            () =>
              checked(() =>
                db.inputEvent.count({ where: { worldId: saved.worldId, userId: owner.id, status: 'PENDING' } }),
              ),
            {
              timeout: 10_000,
            },
          )
          .toBe(1),
      );
      signal.throwIfAborted();
      const lease = await acquireLease(db, saved.worldId);
      if (!lease) throw new Error('자기 월드 리스가 필요합니다.');
      await cleanupBoth(async () => {
        await checked(async () => new TurnLoop(db, lease).advanceTo(0, signal));
      }, [() => releaseLease(db, lease)]);
    } catch (error) {
      failures.push(error);
    }
    for (const result of await settled) if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, '실제 사람 입력 정착 실패');
    expect((await request).status).toBe(200);
    const general = await checked(async () =>
      db.general.findUniqueOrThrow({
        where: { worldId_userId: { worldId: saved.worldId, userId: owner.id } },
      }),
    );
    expect(
      await checked(async () => db.generalTurn.count({ where: { worldId: saved.worldId, generalId: general.id } })),
    ).toBe(30);
    expect(await checked(async () => db.general.count({ where: { worldId: saved.worldId, userId: null } }))).toBe(491);
    await checked(async () => controlClock(db, saved.worldId, 'pause'));
    await checked(async () =>
      db.message.create({
        data: {
          worldId: saved.worldId,
          scope: 'WORLD',
          body: '기존 기록 보존',
          senderId: general.id,
          fromParty: { kind: 'GENERAL', id: general.id, name: general.name },
          year: 191,
          month: 1,
        },
      }),
    );
  }
});
it('AC-M3-04 접수는 PENDING·요청 감사만 원자 생성하고 seed생략 중복은 같은 계획을 돌려준다', async (signal) => {
  const before = await footprint(['WorldCreateRequest', 'AuditLog']),
    old = await oldFootprints();
  const pair = await accepted(actor, signal, { ruleFeatures: ['policy'] });
  firstRequest = pair.receipt;
  expect(firstRequest).toEqual({
    userId: actor.id,
    requestId: expect.any(String),
    idempotencyKey: pair.payload.idempotencyKey,
    status: 'PENDING',
    worldId: null,
    error: null,
  });
  const stored = await row(firstRequest.requestId);
  expect(stored.effectiveSeed.length > 0).toBe(true);
  expect(stored.intent).toMatchObject({ seed: null });
  expect(await db.world.count({ where: { id: stored.plannedWorldId } })).toBe(0);
  const duplicate = await concurrent([create(actor, pair.payload, signal), create(actor, pair.payload, signal)]);
  for (const result of duplicate) expect(result.data).toEqual(firstRequest);
  expect((await row(firstRequest.requestId)).effectiveSeed === stored.effectiveSeed, '같은 seed').toBe(true);
  expect(await auditCount('world.create.requested', stored.id)).toBe(1);
  expect(await footprint(['WorldCreateRequest', 'AuditLog'])).toBe(before);
  expect(await oldFootprints()).toEqual(old);
  expect((await create(actor, { ...pair.payload, name: '다른 의도' }, signal)).code).toBe('CONFLICT');
  await processOne(signal);
});
it('AC-M3-04 실제 엔진 생성은 PREOPEN·정식21국491NPC·14730예약·DONE·적용감사1회다', async (signal) => {
  const before = await oldFootprints(),
    stored = await row(firstRequest.requestId);
  expect(stored.status).toBe('DONE');
  expect(stored.worldId).toBe(stored.plannedWorldId);
  expect(stored.resolution).not.toBeNull();
  const world = await db.world.findUniqueOrThrow({ where: { id: stored.worldId! } });
  expect([world.status, world.clockTick, world.clockRevision, world.actionSequence, world.replayFormat]).toEqual([
    'PREOPEN',
    0,
    0,
    0,
    3,
  ]);
  expect(await db.nation.count({ where: { worldId: world.id } })).toBe(21);
  expect(await db.general.count({ where: { worldId: world.id, userId: null } })).toBe(491);
  expect(await db.general.count({ where: { worldId: world.id, userId: { not: null } } })).toBe(0);
  expect(await db.generalTurn.count({ where: { worldId: world.id } })).toBe(491 * 30);
  expect(await auditCount('world.create.applied', stored.id)).toBe(1);
  expect((await status(actor, stored.idempotencyKey, signal)).data).toMatchObject({
    status: 'DONE',
    worldId: world.id,
  });
  expect(await processOne(signal)).toBe(false);
  expect(await oldFootprints()).toEqual(before);
});
for (const path of ['admin.world.create', 'admin.world.createStatus'] as const)
  for (const category of categories)
    it(
      path + ' ' + category,
      authzCase(path, category, async () => {
        const signal = AbortSignal.timeout(25_000),
          owner = await user(
            category === 'otherUser' ? 'USER' : 'ADMIN',
            category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE',
          );
        const base = input(owner),
          prepared = path.endsWith('Status') && category === 'success' ? await accepted(owner, signal) : null;
        const data = path.endsWith('Status')
          ? { expectedUserId: owner.id, idempotencyKey: prepared?.receipt.idempotencyKey ?? randomUUID() }
          : base;
        const before = await footprint(category === 'success' ? ['WorldCreateRequest', 'AuditLog'] : []);
        const result = await call(
          path,
          category === 'invalidInput' ? { ...data, unexpected: true } : data,
          signal,
          category === 'unauthenticated' ? undefined : owner,
          path === 'admin.world.create',
        );
        if (category === 'success') {
          expect(result.status).toBe(200);
          expect(result.data?.userId).toBe(owner.id);
        } else {
          expect(result.code).toBe(
            category === 'otherUser' ? 'FORBIDDEN' : category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED',
          );
          expect(result.data).toBeUndefined();
        }
        expect(await footprint(category === 'success' ? ['WorldCreateRequest', 'AuditLog'] : [])).toBe(before);
        if (category === 'success') await processOne(signal);
      }),
    );
it('AC-M3-04 자기 키·requestId만 읽고 다른 관리자 및 expected UUID ABA는 거부한다', async (signal) => {
  const before = await footprint();
  expect((await status(peer, firstRequest.idempotencyKey, signal)).code).toBe('NOT_FOUND');
  expect(
    (
      await call(
        'admin.world.createStatus',
        { expectedUserId: peer.id, requestId: firstRequest.requestId },
        signal,
        peer,
      )
    ).code,
  ).toBe('NOT_FOUND');
  expect((await create(peer, input(actor), signal)).code).toBe('UNAUTHORIZED');
  expect(
    (
      await call(
        'admin.world.createStatus',
        { expectedUserId: actor.id, idempotencyKey: firstRequest.idempotencyKey },
        signal,
        peer,
      )
    ).code,
  ).toBe('UNAUTHORIZED');
  expect(
    (
      await call(
        'admin.world.createStatus',
        { expectedUserId: actor.id, requestId: firstRequest.requestId },
        signal,
        actor,
      )
    ).data?.worldId,
  ).toBe((await row(firstRequest.requestId)).worldId);
  expect(await footprint()).toBe(before);
});
it('AC-M3-04 같은 키를 다른 관리자가 쓰면 독립 계획이고 두 consumer는 각 계획을 한 번만 만든다', async (signal) => {
  const key = randomUUID(),
    a = await accepted(actor, signal, { idempotencyKey: key }),
    b = await accepted(peer, signal, { idempotencyKey: key });
  expect(a.receipt.requestId === b.receipt.requestId).toBe(false);
  await concurrent([processOne(signal), processOne(signal)]);
  while (await processOne(signal)) signal.throwIfAborted();
  for (const receipt of [a.receipt, b.receipt]) {
    const current = await row(receipt.requestId);
    expect(current.status).toBe('DONE');
    expect(await db.world.count({ where: { id: current.plannedWorldId } })).toBe(1);
    expect(await auditCount('world.create.applied', current.id)).toBe(1);
  }
});
it('AC-M3-04 요청 감사 실패는 새 요청·월드·모든 기존행을 되돌리고 원문을 응답하지 않는다', async (signal) => {
  const before = await footprint();
  await scopedFault('AuditLog', "NEW.action='world.create.requested'", async () => {
    const result = await create(actor, input(actor), signal);
    expect(result.status).toBe(500);
    expect(result.data).toBeUndefined();
    expect(result.raw.includes('private create write refused')).toBe(false);
    await noPrivate(result.raw);
    expect(await footprint()).toBe(before);
  });
});
for (const mode of ['role', 'session', 'sanction'] as const)
  it('AC-M3-04 잠금 뒤 현재 ' + mode + ' 재검사는 접수를 거부한다', async (signal) => {
    const owner = await user(),
      before = await footprint(['User', 'Session', 'Sanction']);
    await gate.query('BEGIN');
    const failures: unknown[] = [];
    let response: Promise<Response> | undefined, settled: Promise<PromiseSettledResult<Response>[]> | undefined;
    try {
      signal.throwIfAborted();
      const blocker = await gate.query('SELECT pg_backend_pid()::int AS pid');
      const gatePid = Number(blocker.rows[0]!.pid);
      expect(Number.isSafeInteger(gatePid) && gatePid > 0, '자기 gate backend PID').toBe(true);
      if (mode === 'session') await gate.query('SELECT id FROM "Session" WHERE id=$1 FOR UPDATE', [owner.sessionId]);
      else await gate.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [owner.id]);
      response = create(owner, input(owner), signal);
      settled = Promise.allSettled([response]);
      await expect
        .poll(
          async () => {
            signal.throwIfAborted();
            const waits = await gate.query(
              "SELECT pid::int AS pid FROM pg_stat_activity WHERE datname=$1 AND pid<>$2 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))",
              [name, gatePid],
            );
            signal.throwIfAborted();
            return waits.rows.some((row) => Number.isSafeInteger(Number(row.pid)) && Number(row.pid) !== gatePid);
          },
          { timeout: 5000 },
        )
        .toBe(true);
      signal.throwIfAborted();
      if (mode === 'role') await gate.query('UPDATE "User" SET role=$1 WHERE id=$2', ['USER', owner.id]);
      if (mode === 'session')
        await gate.query('UPDATE "Session" SET "expiresAt"=$1 WHERE id=$2', [new Date(0), owner.sessionId]);
      if (mode === 'sanction')
        await gate.query(
          'INSERT INTO "Sanction" (id,"userId",reason,"createdBy","createdAt") VALUES ($1,$2,$3,$2,CURRENT_TIMESTAMP)',
          [randomUUID(), owner.id, '현재 전역 제재'],
        );
      await gate.query('COMMIT');
      const result = await response;
      expect(result.code).toBe(mode === 'role' ? 'FORBIDDEN' : 'UNAUTHORIZED');
      expect(await footprint(['User', 'Session', 'Sanction'])).toBe(before);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await gate.query('ROLLBACK');
      } catch (error) {
        failures.push(error);
      }
      if (settled) for (const result of await settled) if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length) throw new AggregateError(failures, '현재 권한 경합·정리 실패');
  });
it('AC-M3-04 Context 뒤 만료·이메일·동의·정책 변경도 현재 생성과 조회를 다시 검사한다', async () => {
  for (const mode of ['expired', 'unverified', 'consent', 'policy'] as const) {
    const owner = await user('ADMIN', 'ACTIVE', mode !== 'unverified'),
      identity: Context = {
        db,
        publicMapConfig: publicMapConfig({}),
        user: { id: owner.id, email: owner.email },
        sessionId: owner.sessionId,
        now: Date.now(),
        ip: '127.0.0.1',
        dummyPasswordHash: passwordHash,
        secureCookies: false,
        emailVerificationRequired: mode === 'unverified',
        legalPolicy:
          mode === 'consent'
            ? {
                terms: { version: 'create-test-t', effectiveAt: '2026-01-01T00:00:00Z' },
                privacy: { version: 'create-test-p', effectiveAt: '2026-01-01T00:00:00Z' },
              }
            : null,
        legalPolicyRequired: mode === 'policy',
        withdrawalPolicy: null,
        rateLimiter: createRateLimiter({ now: Date.now }),
        reply: { header() {}, setCookie() {}, clearCookie() {}, log: { warn() {} } } as unknown as Context['reply'],
      };
    const caller = appRouter.createCaller(identity);
    if (mode === 'expired')
      await db.session.update({ where: { id: owner.sessionId }, data: { expiresAt: new Date(0) } });
    const before = await footprint(),
      expected = mode === 'policy' ? 'SERVICE_UNAVAILABLE' : mode === 'expired' ? 'UNAUTHORIZED' : 'FORBIDDEN';
    await expect(caller.admin.world.create(input(owner))).rejects.toMatchObject({ code: expected });
    await expect(
      caller.admin.world.createStatus({ expectedUserId: owner.id, idempotencyKey: firstRequest.idempotencyKey }),
    ).rejects.toMatchObject({ code: expected });
    expect(await footprint()).toBe(before);
  }
});
for (const mode of ['role', 'withdrawn', 'sanction', 'logout'] as const)
  it('AC-M3-04 접수 뒤 ' + mode + '와 엔진의 현재 행위자 경계를 구분한다', async (signal) => {
    const owner = await user(),
      receipt = (await accepted(owner, signal)).receipt;
    if (mode === 'role') await db.user.update({ where: { id: owner.id }, data: { role: 'USER' } });
    if (mode === 'withdrawn') await db.user.update({ where: { id: owner.id }, data: { status: 'WITHDRAWN' } });
    if (mode === 'sanction')
      await db.sanction.create({ data: { userId: owner.id, createdBy: owner.id, reason: '접수 뒤 전역 제재' } });
    if (mode === 'logout') await db.session.delete({ where: { id: owner.sessionId } });
    const old = await oldFootprints();
    await processOne(signal);
    const current = await row(receipt.requestId);
    if (mode === 'logout') {
      expect(current.status).toBe('DONE');
      expect(current.worldId).toBe(current.plannedWorldId);
    } else {
      expect(current.status).toBe('FAILED');
      expect(current.errorCode).toBe(
        mode === 'role' ? 'ADMIN_REQUIRED' : mode === 'withdrawn' ? 'ACTOR_INACTIVE' : 'ACTOR_SANCTIONED',
      );
      expect(await db.world.count({ where: { id: current.plannedWorldId } })).toBe(0);
      expect(await auditCount('world.create.rejected', current.id)).toBe(1);
    }
    expect(await oldFootprints()).toEqual(old);
  });
for (const table of ['World', 'Nation', 'City', 'General', 'GeneralTurn', 'WorldCreateRequest', 'AuditLog'])
  it('AC-M3-04 실제 ' + table + ' 적용 쓰기 실패는 월드0·PENDING·기존행을 보존한다', async (signal) => {
    // 초기 GeneralTurn 쓰기는 정책 기능을 고른 월드에서만 발생한다.
    const receipt = (await accepted(actor, signal, table === 'GeneralTurn' ? { ruleFeatures: ['policy'] } : {}))
        .receipt,
      initial = await row(receipt.requestId);
    const before = await footprint(['WorldCreateRequest']),
      otherRequests = JSON.stringify(
        await db.worldCreateRequest.findMany({ where: { id: { not: initial.id } }, orderBy: { id: 'asc' } }),
      );
    const when =
      table === 'WorldCreateRequest'
        ? "NEW.status='DONE'"
        : table === 'AuditLog'
          ? "NEW.action='world.create.applied'"
          : 'TRUE';
    await scopedFault(table, when, async () => {
      const results = await Promise.allSettled([processOne(signal)]);
      expect(results[0]?.status).toBe('rejected');
      expect(await db.world.count({ where: { id: initial.plannedWorldId } })).toBe(0);
      const current = await row(initial.id);
      expect(current.status).toBe('PENDING');
      expect(current.worldId).toBeNull();
      expect(current.processedAt).toBeNull();
      expect(current.errorCode).toBeNull();
      expect(await footprint(['WorldCreateRequest'])).toBe(before);
      expect({ ...current, resolution: null }).toEqual({ ...initial, resolution: null });
      expect(
        JSON.stringify(
          await db.worldCreateRequest.findMany({ where: { id: { not: initial.id } }, orderBy: { id: 'asc' } }),
        ) === otherRequests,
        '다른 모든 생성 요청 보존',
      ).toBe(true);
    });
    await processOne(signal);
    expect((await row(initial.id)).status).toBe('DONE');
  });
for (const [field, value, code] of [
  ['scenarioKey', 'missing', 'RESOURCE_INVALID'],
  ['presetKey', 'missing', 'RESOURCE_INVALID'],
  ['endYear', 1, 'INPUT_INVALID'],
  ['ruleFeatures', ['campaign-assignment-v2'], 'INPUT_INVALID'],
] as const)
  it('AC-M3-04 확정 불가 ' + field + '는 고정 FAILED이며 같은 키는 재생성하지 않는다', async (signal) => {
    const acceptedRequest = await accepted(actor, signal, { [field]: value }),
      old = await oldFootprints();
    await processOne(signal);
    const current = await row(acceptedRequest.receipt.requestId);
    expect(current.status).toBe('FAILED');
    expect(current.errorCode).toBe(code);
    expect(current.processedAt).not.toBeNull();
    const repeated = await create(actor, acceptedRequest.payload, signal);
    expect(repeated.data?.status).toBe('FAILED');
    expect(repeated.data?.error?.code).toBe(code);
    expect(repeated.raw.includes('stack')).toBe(false);
    await noPrivate(repeated.raw);
    expect(await db.world.count({ where: { id: current.plannedWorldId } })).toBe(0);
    expect(await oldFootprints()).toEqual(old);
  });
it('AC-M3-04 프리셋 위에 명시한 정식 자원·간격·긴 이름을 유지한다', async (signal) => {
  const long = '긴 이름'.repeat(100),
    request = await accepted(actor, signal, {
      presetKey: 'regular',
      name: long,
      turnTermMinutes: 7,
      seed: 'create-fixed-seed',
    });
  await processOne(signal);
  const stored = await row(request.receipt.requestId),
    world = await db.world.findUniqueOrThrow({ where: { id: stored.worldId! } });
  expect([
    world.name,
    world.scenarioKey,
    world.mapKey,
    world.presetKey,
    world.turnTermMinutes,
    world.endYear,
    world.seed,
  ]).toEqual([long, 'integration191', 'integration', 'regular', 7, 300, 'create-fixed-seed']);
  expect(await db.general.count({ where: { worldId: world.id } })).toBe(491);
  expect(world.statRules).toEqual(
    (
      await loadInitialWorldFromDb(db, {
        scenario: 'integration191',
        map: 'integration',
        statRules: 'five-stats',
        portraitMap: '191-map',
        seed: 'create-fixed-seed',
      })
    ).statRules,
  );
});
it('AC-M3-04 해시가 손상된 새 게시 자원은 기존 게시물을 바꾸지 않고 거부한다', async (signal) => {
  const resource = await db.gameResource.findUniqueOrThrow({
    where: { kind_name_version: { kind: 'MAP', name: 'integration', version: 1 } },
  });
  const brokenName = 'bad_' + randomUUID().replaceAll('-', '');
  const content = { ...(resource.content as Record<string, unknown>), id: brokenName };
  await db.gameResource.create({
    data: {
      kind: 'MAP',
      name: brokenName,
      version: 1,
      status: 'PUBLISHED',
      content,
      contentHash: '0'.repeat(64),
      source: '실제 읽기 실패 전용 고정물',
      publishedAt: new Date(),
    },
  });
  const old = await oldFootprints(),
    receipt = (await accepted(actor, signal, { mapKey: brokenName })).receipt;
  await processOne(signal);
  const current = await row(receipt.requestId);
  expect(current.status).toBe('FAILED');
  expect(current.errorCode).toBe('RESOURCE_INVALID');
  expect(await db.world.count({ where: { id: current.plannedWorldId } })).toBe(0);
  expect(await oldFootprints()).toEqual(old);
});
it('AC-M3-04 고정 resolution 불일치는 다른 설정으로 재생성하지 않는다', async (signal) => {
  const receipt = (await accepted(actor, signal)).receipt;
  // 내부 고정 명세 손상 반례다. HTTP는 resolution을 받지 않으며 기존 게시 자원은 불변이다.
  await db.worldCreateRequest.update({
    where: { id: receipt.requestId },
    data: { resolution: { version: 1, invalid: true } },
  });
  await processOne(signal);
  const current = await row(receipt.requestId);
  expect(current.status).toBe('FAILED');
  expect(current.errorCode).toBe('RESOURCE_INVALID');
  expect(await db.world.count({ where: { id: current.plannedWorldId } })).toBe(0);
});

function spawnEngine(
  signal: AbortSignal,
  worldId?: string,
  databaseUrl = target.href,
  purpose = worldId ? 'single-world' : 'supervisor',
) {
  signal.throwIfAborted();
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../apps/engine/src/index.ts', import.meta.url)),
      ...(worldId ? ['--world', worldId] : []),
    ],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let resolve!: () => void;
  const item: OwnedChild = {
    child,
    closed: new Promise((done) => {
      resolve = done;
    }),
    code: undefined,
    signal: undefined,
    stdoutEnded: false,
    stderrEnded: false,
    output: '',
    purpose,
  };
  children.push(item);
  child.once('error', (error) => {
    item.spawnError = error;
    errors.push(error);
  });
  child.stdout!.on('data', (chunk) => {
    item.output += String(chunk);
  });
  child.stdout!.once('end', () => {
    item.stdoutEnded = true;
  });
  child.stderr!.on('data', (chunk) => {
    item.output += String(chunk);
  });
  child.stderr!.once('end', () => {
    item.stderrEnded = true;
  });
  const abort = () => {
    void track(() => stopChild(item));
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  child.once('close', (code, exitSignal) => {
    signal.removeEventListener('abort', abort);
    item.code = code;
    item.signal = exitSignal;
    item.closedAt = new Date().toISOString();
    resolve();
  });
  return item;
}
function stopChild(item: OwnedChild): Promise<void> {
  item.stopping ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        stopOwnedChild(item.child, item.closed),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('자기 자식 actual close 기한 초과')), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect(item.stdoutEnded && item.stderrEnded, '실제 자식 두 stream 종료').toBe(true);
    expect(item.spawnError === undefined, 'spawn 오류 없음').toBe(true);
    await noPrivate(item.output);
    logs.push(item.output);
  })();
  return item.stopping;
}

it('AC-M3-04 실제 --world 실행기는 관련 없는 생성 큐를 소비하지 않는다', async (signal) => {
  const request = await accepted(actor, signal),
    before = await oldFootprints(),
    child = spawnEngine(signal, (await row(firstRequest.requestId)).worldId!);
  await cleanupBoth(async () => {
    await expect.poll(() => child.output.includes('[engine] 시작'), { timeout: 10_000 }).toBe(true);
    await delay(1200, undefined, { signal });
    expect((await row(request.receipt.requestId)).status).toBe('PENDING');
    expect(await oldFootprints()).toEqual(before);
  }, [() => stopChild(child)]);
  expect(child.code).toBe(0);
  await processOne(signal);
});
it('AC-M3-04 실제 감독은 새 큐를 만들고 재시작해도 같은 요청은 월드1개다', async (signal) => {
  const request = await accepted(actor, signal),
    child = spawnEngine(signal);
  await cleanupBoth(async () => {
    await expect.poll(async () => (await row(request.receipt.requestId)).status, { timeout: 20_000 }).toBe('DONE');
  }, [() => stopChild(child)]);
  expect(child.code).toBe(0);
  const current = await row(request.receipt.requestId),
    replay = spawnEngine(signal);
  await cleanupBoth(async () => {
    await expect.poll(() => replay.output.includes('[engine] 시작'), { timeout: 10_000 }).toBe(true);
    await delay(1200, undefined, { signal });
    expect(await db.world.count({ where: { id: current.plannedWorldId } })).toBe(1);
    expect(await auditCount('world.create.applied', current.id)).toBe(1);
  }, [() => stopChild(replay)]);
  expect(replay.code).toBe(0);
});

it('AC-M3-04 이미 취소한 consumer는 접수·월드·감사를 변경하지 않는다', async () => {
  const before = await footprint(),
    controller = new AbortController();
  controller.abort();
  await expect(processWorldCreateRequest(db, controller.signal)).rejects.toBeDefined();
  expect(await footprint()).toBe(before);
});
it('AC-M3-04 단일 PENDING을 두 실제 consumer가 경합해도 World·DONE·감사는 한 번이다', async (signal) => {
  const { receipt } = await accepted(actor, signal);
  const results = await concurrent([processOne(signal), processOne(signal)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const current = await row(receipt.requestId);
  expect(current.status).toBe('DONE');
  expect(await db.world.count({ where: { id: current.plannedWorldId } })).toBe(1);
  expect(await auditCount('world.create.applied', current.id)).toBe(1);
});
it('AC-M3-04 프리셋만 지정한 요청도 검증된 기존 기본 자원을 고정한다', async (signal) => {
  const result = await create(
    actor,
    {
      expectedUserId: actor.id,
      idempotencyKey: randomUUID(),
      name: '프리셋 기본',
      presetKey: 'regular',
      endYear: 300,
      seed: 'create-preset-only',
    },
    signal,
  );
  expect(result.status).toBe(200);
  if (!result.data) throw new Error('실제 프리셋 접수가 필요합니다.');
  await processOne(signal);
  const current = await row(result.data.requestId),
    world = await db.world.findUniqueOrThrow({ where: { id: current.worldId! } });
  expect([world.status, world.scenarioKey, world.mapKey, world.presetKey, world.turnTermMinutes]).toEqual([
    'PREOPEN',
    'san10-191',
    'san10',
    'regular',
    60,
  ]);
  expect(await db.nation.count({ where: { worldId: world.id } })).toBe(21);
  expect(await db.general.count({ where: { worldId: world.id, userId: null } })).toBe(491);
});

it('AC-M3-04 crash 전용 UUID DB에 전체 migration·게시 자원·PENDING을 준비한다', async (signal) => {
  signal.throwIfAborted();
  expect(
    (await checked(async () => admin.query('SELECT oid FROM pg_database WHERE datname=$1', [crash.name]))).rows,
  ).toHaveLength(0);
  await checked(async () => admin.query('CREATE DATABASE "' + crash.name + '"'));
  crash.created = true;
  crash.oid = String(
    (await checked(async () => admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [crash.name])))
      .rows[0]!.oid,
  );
  await checked(async () => admin.query('ALTER DATABASE "' + crash.name + '" SET statement_timeout=10000'));
  await checked(async () => crash.gate.connect());
  const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
  for (const migration of (await checked(async () => readdir(migrations)))
    .filter((value) => /^\d{14}_/.test(value))
    .sort()) {
    signal.throwIfAborted();
    await checked(async () =>
      crash.gate.query(await checked(async () => readFile(new URL(migration + '/migration.sql', migrations), 'utf8'))),
    );
  }
  await checked(async () =>
    initializeResources(
      crash.db,
      await checked(async () => readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8')),
    ),
  );
  await checked(async () => initializeIntegrationResources(crash.db));
  crash.address = await checked(async () => start({ db: crash.db }));
  crash.owner = await checked(async () => user('ADMIN', 'ACTIVE', true, crash.db));
  const owner = crash.owner;
  const response = await checked(async () =>
    create(
      owner,
      input(owner, { seed: 'actual-supervisor-crash-fixed', ruleFeatures: ['policy'] }),
      signal,
      crash.address,
    ),
  );
  expect(response.status).toBe(200);
  if (!response.data) throw new Error('실제 crash 접수가 필요합니다.');
  crash.requestId = response.data.requestId;
  crash.key = response.data.idempotencyKey;
  crash.plannedWorldId = (
    await checked(async () => crash.db.worldCreateRequest.findUniqueOrThrow({ where: { id: crash.requestId } }))
  ).plannedWorldId;
  expect(await checked(async () => crash.db.world.count())).toBe(0);
});
it('AC-M3-04 실제 감독을 INSERT 대기 중 SIGKILL하면 PENDING·월드0·고정명세를 보존한다', async (signal) => {
  const old = await oldFootprints();
  await crash.gate.query('SELECT pg_advisory_lock(73419,91237)');
  let child: OwnedChild | undefined;
  await cleanupBoth(async () => {
    await crash.gate.query(
      'CREATE FUNCTION create_crash_insert_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(73419,91237); RETURN NEW; END $$',
    );
    await crash.gate.query(
      'CREATE TRIGGER create_crash_insert_wait BEFORE INSERT ON "World" FOR EACH ROW EXECUTE FUNCTION create_crash_insert_wait()',
    );
    child = spawnEngine(signal, undefined, crash.url.href, 'crash-before-commit');
    await expect
      .poll(
        async () =>
          Boolean((await crash.db.worldCreateRequest.findUniqueOrThrow({ where: { id: crash.requestId } })).resolution),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          Number(
            (
              await crash.gate.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND wait_event='advisory'",
                [crash.name],
              )
            ).rows[0]!.n,
          ),
        { timeout: 5000 },
      )
      .toBe(1);
    // 이 DB에는 World가 없어 감독의 --world 자식이 없다. 자기 실제 감독만 강제 종료한다.
    expect(await crash.db.world.count()).toBe(0);
    expect(child.child.kill('SIGKILL'), '자기 supervisor SIGKILL 전송').toBe(true);
    await stopChild(child);
    expect(
      child.signal === 'SIGKILL' || (child.code !== null && child.code !== undefined && child.code !== 0),
      '정상 종료0과 구분한 실제 강제 종료',
    ).toBe(true);
    const current = await crash.db.worldCreateRequest.findUniqueOrThrow({ where: { id: crash.requestId } });
    expect(current.status).toBe('PENDING');
    expect(current.worldId).toBeNull();
    expect(current.resolution).not.toBeNull();
    expect(await crash.db.world.count()).toBe(0);
    expect(await crash.db.auditLog.count({ where: { action: 'world.create.applied' } })).toBe(0);
    expect(await oldFootprints()).toEqual(old);
  }, [
    async () => {
      if (child) await stopChild(child);
    },
    () => crash.gate.query('SELECT pg_advisory_unlock(73419,91237)'),
    () => crash.gate.query('DROP TRIGGER IF EXISTS create_crash_insert_wait ON "World"'),
    () => crash.gate.query('DROP FUNCTION IF EXISTS create_crash_insert_wait()'),
  ]);
});
it('AC-M3-04 crash 뒤 실제 새 감독은 같은 계획을 DONE·PREOPEN 한 번으로 복구한다', async (signal) => {
  const old = await oldFootprints(),
    child = spawnEngine(signal, undefined, crash.url.href, 'crash-recovery');
  await cleanupBoth(async () => {
    await expect
      .poll(
        async () => (await crash.db.worldCreateRequest.findUniqueOrThrow({ where: { id: crash.requestId } })).status,
        { timeout: 20_000 },
      )
      .toBe('DONE');
  }, [() => stopChild(child)]);
  expect(child.code).toBe(0);
  const current = await crash.db.worldCreateRequest.findUniqueOrThrow({ where: { id: crash.requestId } });
  expect(current.worldId).toBe(crash.plannedWorldId);
  expect(await crash.db.world.count()).toBe(1);
  expect((await crash.db.world.findUniqueOrThrow({ where: { id: crash.plannedWorldId } })).status).toBe('PREOPEN');
  expect(await crash.db.nation.count({ where: { worldId: crash.plannedWorldId } })).toBe(21);
  expect(await crash.db.general.count({ where: { worldId: crash.plannedWorldId, userId: null } })).toBe(491);
  expect(await crash.db.generalTurn.count({ where: { worldId: crash.plannedWorldId } })).toBe(491 * 30);
  expect(await crash.db.auditLog.count({ where: { action: 'world.create.requested' } })).toBe(1);
  expect(await crash.db.auditLog.count({ where: { action: 'world.create.applied' } })).toBe(1);
  if (!crash.owner) throw new Error('자기 crash actor가 필요합니다.');
  const response = await call(
    'admin.world.createStatus',
    { expectedUserId: crash.owner.id, idempotencyKey: crash.key },
    signal,
    crash.owner,
    false,
    crash.address,
  );
  expect(response.data?.worldId).toBe(crash.plannedWorldId);
  expect(await oldFootprints()).toEqual(old);
});

for (const hook of ['setup', 'cleanup'])
  it('AC-M3-04 ' + hook + ' 기한 뒤 원 작업이 성공해도 실패 DB 보존은 영구적이다', async () => {
    const localErrors: unknown[] = [],
      guard = suiteGuard((error) => localErrors.push(error));
    let resolve!: () => void;
    const late = new Promise<void>((done) => {
      resolve = done;
    });
    await expect(
      guard.hook(
        hook,
        () => late,
        (work) => Promise.resolve().then(work),
        5,
      ),
    ).rejects.toThrow('DB 보존');
    resolve();
    await late;
    await Promise.resolve();
    expect(guard.failed).toBe(true);
    expect(localErrors.length).toBeGreaterThan(0);
    let drops = 0;
    if (!guard.failed) drops++;
    expect(drops).toBe(0);
  });
