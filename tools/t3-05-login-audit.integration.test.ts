import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import { withdrawAccount } from '../apps/server/src/auth/withdrawalStore';
import { testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';

type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string; connectionTimeoutMillis?: number }) => Pg;
};
if (!process.env.TEST_DATABASE_URL) throw new Error('전용 시험 DB가 필요합니다.');
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('loopback 시험 서버가 필요합니다.');
for (const key of source.searchParams.keys())
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    throw new Error('접속 대상 질의 인자는 쓸 수 없습니다.');
const name = 't305_login_' + randomUUID().replaceAll('-', '') + '_test';
const target = new URL(source),
  adminUrl = new URL(source);
target.pathname = '/' + name;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 10_000 }),
  gate = new Client({ connectionString: target.href, connectionTimeoutMillis: 10_000 }),
  db = createDb(target.href);
const origin = 'http://127.0.0.1:5173',
  key = randomBytes(32).toString('hex'),
  password = randomUUID(),
  logs: string[] = [],
  sensitive = new Set([key, password]),
  databaseSecrets = new Set([key, password, '127.0.0.1']),
  errors: unknown[] = [],
  pending = new Set<Promise<unknown>>(),
  apps = new Set<Awaited<ReturnType<typeof buildServer>>>();
let oid: string | undefined, passwordHash: string;
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
function it(title: string, work: (signal: AbortSignal) => Promise<void>, timeout = 30_000) {
  test(
    title,
    ({ onTestFailed }) => {
      const controller = new AbortController();
      onTestFailed(() => {
        controller.abort();
        suite.fail(new Error('실패한 자기 로그인 DB를 보존합니다.'));
      });
      return track(() => operationSignals.run(controller.signal, () => work(controller.signal)));
    },
    timeout,
  );
}
beforeEach(settle);
beforeAll(
  () =>
    suite.hook(
      'setup',
      async (signal) => {
        await checked(() => admin.connect(), signal);
        await checked(() => admin.query('SET statement_timeout=10000'), signal);
        await checked(() => admin.query('SET lock_timeout=10000'), signal);
        expect(
          (await checked(() => admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name]), signal)).rows,
        ).toHaveLength(0);
        await checked(() => admin.query('CREATE DATABASE "' + name + '"'), signal);
        oid = String(
          (
            await checked(
              () => admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name]),
              signal,
            )
          ).rows[0]!.oid,
        );
        await checked(() => admin.query('ALTER DATABASE "' + name + '" SET statement_timeout=10000'), signal);
        await checked(() => gate.connect(), signal);
        const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
        for (const migration of (await checked(() => readdir(migrations), signal))
          .filter((value) => /^\d{14}_/.test(value))
          .sort()) {
          signal.throwIfAborted();
          const sql = await checked(() => readFile(new URL(migration + '/migration.sql', migrations), 'utf8'), signal);
          await checked(() => gate.query(sql), signal);
        }
        passwordHash = await checked(() => hashPassword(password), signal);
        sensitive.add(passwordHash);
      },
      track,
    ),
  120_000,
);

afterAll(
  () =>
    suite.hook('cleanup', async (signal) => {
      const deadline = Date.now() + 110_000;
      // Both original body and setup remain tracked after a wrapper deadline.
      await cleanupAttempt(settle, 40_000, false);
      if (!pending.size)
        await cleanupAttempt(async () => {
          const auditSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
          if (oid) {
            const tables = (
              await checked(
                () => gate.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"),
                auditSignal,
              )
            ).rows;
            for (const { tablename } of tables) {
              auditSignal.throwIfAborted();
              if (typeof tablename !== 'string') throw new Error('자기 DB 표 이름을 확인하세요.');
              const quoted = '"' + tablename.replaceAll('"', '""') + '"';
              const rows = await checked(
                () =>
                  gate.query("SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb)::text AS body FROM " + quoted + ' t'),
                auditSignal,
              );
              const body = String(rows.rows[0]!.body);
              if ([...databaseSecrets].some((secret) => body.includes(secret)))
                throw new Error('자기 DB에 원문 비공개 값이 포함됐습니다.');
            }
          }
        }, 30_000);
      const closers: Array<() => Promise<unknown>> = [...apps].map((app) => () => app.close());
      closers.push(
        () => gate.end(),
        () => db.$disconnect(),
      );
      await Promise.all(closers.map((close) => cleanupAttempt(close)));
      if (pending.size) suite.fail(new Error('미정착 원 작업이 있어 DB 보존'));
      const allLogs = logs.join('\n');
      if (allLogs.includes('127.0.0.1') || [...sensitive].some((value) => allLogs.includes(value)))
        suite.fail(new Error('전체 종료 로그에 비공개 값이 포함됐습니다.'));
      let connections: number | undefined,
        dropped = false;
      try {
        if (oid) {
          ({ connections } = await checked(() => confirmDisconnectedDatabase(admin, name, oid!), signal));
          if (!suite.failed && !errors.length && !pending.size && !signal.aborted) {
            if (Date.now() + 30_000 >= deadline) throw new Error('DROP 전 독립 정리 예산 부족: DB 보존');
            const identity = await checked(
              () => admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name]),
              signal,
            );
            expect(identity.rows).toEqual([{ oid }]);
            signal.throwIfAborted();
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
      const adminClosed = await cleanupAttempt(() => admin.end());
      console.info(
        JSON.stringify({
          event: 'login-audit-cleanup',
          name,
          oid,
          connections,
          dropped,
          adminClosed,
          suiteFailed: suite.failed,
          hookAborted: signal.aborted,
          pendingOperations: pending.size,
          errors: errors.length,
        }),
      );
      if (errors.length) throw new AggregateError([...new Set(errors)], '조사 실행·자기 자원 정리 실패');
    }),
  120_000,
);

async function start(options: Partial<Parameters<typeof buildServer>[0]> = {}) {
  const app = await buildServer({
    db,
    publicOrigin: origin,
    loginAudit: { key, version: 1 },
    logStream: {
      write: (chunk: string) => {
        logs.push(chunk);
      },
    },
    ...options,
  });
  apps.add(app);
  return { app, address: await app.listen({ host: '127.0.0.1', port: 0 }) };
}
async function call(
  address: string,
  path: string,
  input: unknown,
  signal: AbortSignal,
  cookie?: string,
  requestOrigin = origin,
) {
  const response = await fetch(address + '/trpc/' + path + '?batch=1', {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { origin: requestOrigin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ 0: input }),
  });
  const raw = await response.text();
  const body = (
    JSON.parse(raw) as Array<{
      result?: { data: { user?: { id: string; email: string } } };
      error?: { message: string; data: { code: string } };
    }>
  )[0]!;
  const headers = response.headers.getSetCookie();
  const sid = headers.find((value) => value.startsWith('sid='))?.split(';')[0];
  const did = headers.find((value) => value.startsWith('did='))?.split(';')[0];
  for (const item of [sid?.slice(4), did?.slice(4)])
    if (item) {
      sensitive.add(item);
      databaseSecrets.add(item);
    }
  return { status: response.status, raw, body, headers, sid, did };
}
async function signup(address: string, signal: AbortSignal, cookie?: string) {
  const email = randomUUID() + '@example.test';
  sensitive.add(email);
  const result = await call(address, 'auth.signup', { email, password }, signal, cookie);
  expect(result.status).toBe(200);
  expect(result.body.result?.data.user?.id).toBeDefined();
  return { ...result, email, id: result.body.result!.data.user!.id };
}
async function records(userId: string) {
  return db.$queryRaw<Array<{ ipHash: string; deviceHash: string; success: boolean; hashKeyVersion: number }>>`
    SELECT "ipHash","deviceHash",success,"hashKeyVersion" FROM "LoginRecord" WHERE "userId"=${userId} ORDER BY id`;
}

it('AC-M3-05 실제 가입·로그인·실패·로그아웃에 해시만 기록하고 쿠키를 유지한다', async (signal) => {
  const { address } = await start();
  const user = await signup(address, signal);
  expect(/^did=[0-9a-f]{32}$/.test(user.did ?? ''), '기기 쿠키 형식').toBe(true);
  expect(
    user.headers.some((value) => value.startsWith('did=') && value.includes('HttpOnly')),
    '기기 HttpOnly',
  ).toBe(true);
  const digest = (value: string) => createHmac('sha256', key).update(value).digest('hex');
  expect(
    JSON.stringify(await records(user.id)) ===
      JSON.stringify([
        { ipHash: digest('127.0.0.1'), deviceHash: digest(user.did!.slice(4)), success: true, hashKeyVersion: 1 },
      ]),
    '정확한 HMAC 기록',
  ).toBe(true);
  const logout = await call(address, 'auth.logout', undefined, signal, user.sid + '; ' + user.did);
  expect(logout.status).toBe(200);
  expect(logout.headers.some((value) => value.startsWith('did='))).toBe(false);
  const login = await call(address, 'auth.login', { email: user.email, password }, signal, user.did);
  expect(login.status).toBe(200);
  expect(login.did === user.did, '동일 기기 쿠키 보존').toBe(true);
  const count = await db.session.count({ where: { userId: user.id } });
  const bad = await call(address, 'auth.login', { email: user.email, password: password + '!' }, signal, user.did);
  const missingEmail = randomUUID() + '@example.test';
  sensitive.add(missingEmail);
  const missing = await call(address, 'auth.login', { email: missingEmail, password }, signal, user.did);
  expect([bad.status, missing.status]).toEqual([401, 401]);
  expect(bad.body.error?.message === '이메일 또는 비밀번호가 맞지 않습니다', '동일 자격 거부 문구').toBe(true);
  expect(bad.did === user.did, '동일 기기 쿠키 보존').toBe(true);
  expect(missing.did === user.did, '동일 기기 쿠키 보존').toBe(true);
  expect(await db.session.count({ where: { userId: user.id } })).toBe(count);
  expect((await records(user.id)).map((row) => row.success)).toEqual([true, true, false]);
  for (const status of ['SANCTIONED', 'WITHDRAWN'] as const) {
    await db.user.update({ where: { id: user.id }, data: { status } });
    expect(
      (await call(address, 'auth.login', { email: user.email, password }, signal, user.did)).body.error?.message ===
        '이메일 또는 비밀번호가 맞지 않습니다',
      '비활성 계정 동일 거부',
    ).toBe(true);
    expect(await records(user.id)).toHaveLength(3);
  }
  const columns = (
    await gate.query('SELECT column_name FROM information_schema.columns WHERE table_name=$1', ['LoginRecord'])
  ).rows
    .map((row) => row.column_name)
    .sort();
  expect(columns).toEqual(['at', 'deviceHash', 'hashKeyVersion', 'id', 'ipHash', 'success', 'userId'].sort());
  expect(logs.join('\n').includes('127.0.0.1'), '응답·로그 원문 비노출').toBe(false);
  for (const secret of sensitive) expect(logs.join('\n').includes(secret), '로그 비밀값 비노출').toBe(false);
});

it('AC-M3-05 키 교체는 버전을 보존하고 개발 미설정·운영 정책 미확정은 비수집이다', async (signal) => {
  const first = await start(),
    user = await signup(first.address, signal);
  const nextKey = randomBytes(32).toString('hex');
  sensitive.add(nextKey);
  databaseSecrets.add(nextKey);
  const next = await start({ loginAudit: { key: nextKey, version: 2 } });
  expect((await call(next.address, 'auth.login', { email: user.email, password }, signal, user.did)).status).toBe(200);
  const rows = await records(user.id);
  expect(rows.map((row) => row.hashKeyVersion)).toEqual([1, 2]);
  expect(rows[1]!.ipHash !== rows[0]!.ipHash, '교체한 IP 해시').toBe(true);
  expect(rows[1]!.deviceHash !== rows[0]!.deviceHash, '교체한 기기 해시').toBe(true);
  const disabled = await start({ loginAudit: null });
  const ordinary = await signup(disabled.address, signal);
  expect(ordinary.did === undefined, '비수집 기기 쿠키 없음').toBe(true);
  expect((await records(ordinary.id)).length, '남은 기록 수').toBe(0);
  const production = await start({ production: true, publicOrigin: 'https://pending.example.test', legalPolicy: null });
  const login = await call(
    production.address,
    'auth.login',
    { email: user.email, password },
    signal,
    user.did,
    'https://pending.example.test',
  );
  expect(login.status).toBe(200);
  expect(login.did === undefined, '비수집 기기 쿠키 없음').toBe(true);
  expect(
    login.headers.some((value) => value.startsWith('sid=') && value.includes('Secure')),
    '운영 세션 Secure',
  ).toBe(true);
  expect(JSON.stringify(await records(user.id)) === JSON.stringify(rows), '비수집 기록 보존').toBe(true);
});

it('AC-M3-05 실제 기록 INSERT 실패는 가입·세션 생성을 되돌리고 실패 응답도 식별자를 숨긴다', async (signal) => {
  const { address } = await start(),
    user = await signup(address, signal);
  const beforeSessions = await db.session.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
  await gate.query(
    `CREATE FUNCTION login_audit_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit write rejected'; END $$`,
  );
  await gate.query(
    `CREATE TRIGGER login_audit_block BEFORE INSERT ON "LoginRecord" FOR EACH ROW EXECUTE FUNCTION login_audit_block()`,
  );
  const failures: unknown[] = [];
  try {
    const email = randomUUID() + '@example.test';
    sensitive.add(email);
    const rejected = await call(address, 'auth.signup', { email, password }, signal);
    expect(rejected.status).toBe(500);
    expect(rejected.sid === undefined, '거부 세션 쿠키 없음').toBe(true);
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
    const login = await call(address, 'auth.login', { email: user.email, password }, signal);
    expect(login.status).toBe(500);
    expect(login.sid === undefined, '거부 세션 쿠키 없음').toBe(true);
    expect(
      JSON.stringify(await db.session.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } })) ===
        JSON.stringify(beforeSessions),
      '거부 세션 불변',
    ).toBe(true);
    const bad = await call(address, 'auth.login', { email: user.email, password: password + '!' }, signal);
    expect(bad.status).toBe(401);
    expect(bad.body.error?.message === '이메일 또는 비밀번호가 맞지 않습니다', '동일 자격 거부 문구').toBe(true);
    for (const result of [rejected, login, bad]) {
      expect(result.raw.includes('audit write rejected'), '응답·로그 원문 비노출').toBe(false);
      expect(result.raw.includes('INSERT'), '응답·로그 원문 비노출').toBe(false);
      expect(result.raw.includes('127.0.0.1'), '응답·로그 원문 비노출').toBe(false);
      for (const secret of sensitive) expect(result.raw.includes(secret), '오류 비밀값 비노출').toBe(false);
    }
    expect(await records(user.id)).toHaveLength(1);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await gate.query('DROP TRIGGER login_audit_block ON "LoginRecord"');
    } catch (error) {
      failures.push(error);
    }
    try {
      await gate.query('DROP FUNCTION login_audit_block()');
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '로그인 기록 원자성·trigger 정리 실패');
});

it('AC-M3-05 거부 기록만 실패해도 전역 제재·오답·없는 계정은 같은 401이고 DB는 그대로다', async (signal) => {
  const { address } = await start(),
    user = await signup(address, signal);
  // 제재 거부 분기만 통제하는 계정 고정물이며 관리자 제재 API 인수로 세지 않는다.
  await db.sanction.create({
    data: { userId: user.id, worldId: null, reason: '로그인 거부 기록 원자성 고정물', createdBy: user.id },
  });
  const snapshot = async () =>
    JSON.stringify({
      sessions: await db.session.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } }),
      records: await records(user.id),
      inputEvents: await db.inputEvent.count(),
    });
  const before = await snapshot();
  await gate.query(`CREATE FUNCTION login_audit_denial_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NOT NEW.success THEN RAISE EXCEPTION 'denial audit rejected'; END IF; RETURN NEW; END $$`);
  await gate.query(
    `CREATE TRIGGER login_audit_denial_block BEFORE INSERT ON "LoginRecord" FOR EACH ROW EXECUTE FUNCTION login_audit_denial_block()`,
  );
  const failures: unknown[] = [];
  try {
    const missingEmail = randomUUID() + '@example.test';
    sensitive.add(missingEmail);
    const denied = await call(address, 'auth.login', { email: user.email, password }, signal);
    const wrong = await call(address, 'auth.login', { email: user.email, password: password + '!' }, signal);
    const missing = await call(address, 'auth.login', { email: missingEmail, password }, signal);
    for (const result of [denied, wrong, missing]) {
      expect(result.status).toBe(401);
      expect(
        result.body.error?.message === '이메일 또는 비밀번호가 맞지 않습니다' &&
          result.body.error?.data.code === 'UNAUTHORIZED',
        '세 경로 동일 자격 거부',
      ).toBe(true);
      expect(result.sid === undefined, '거부 세션 쿠키 없음').toBe(true);
      expect(result.raw.includes('denial audit rejected'), '응답·로그 원문 비노출').toBe(false);
      for (const secret of sensitive) expect(result.raw.includes(secret), '거부 비밀값 비노출').toBe(false);
    }
    // 해시 비교로 assertion 실패 때도 세션 토큰 해시 원문을 로그에 싣지 않는다.
    const { createHash } = await import('node:crypto');
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(digest(await snapshot())).toBe(digest(before));
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await gate.query('DROP TRIGGER login_audit_denial_block ON "LoginRecord"');
    } catch (error) {
      failures.push(error);
    }
    try {
      await gate.query('DROP FUNCTION login_audit_denial_block()');
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '거부 기록·trigger 정리 실패');
  const rejected = await call(address, 'auth.login', { email: user.email, password }, signal);
  expect(rejected.status).toBe(401);
  expect(rejected.body.error?.message === '이메일 또는 비밀번호가 맞지 않습니다', '동일 자격 거부 문구').toBe(true);
  expect(rejected.sid === undefined, '거부 세션 쿠키 없음').toBe(true);
  expect((await records(user.id)).map((row) => row.success)).toEqual([true, false]);
});

it('AC-M3-05 탈퇴와 실제 로그인 20회 경합에서 탈퇴 뒤 기록·세션·토큰이 남지 않는다', async (signal) => {
  const { address } = await start();
  // 계정 도메인의 경합 고정물이다. 게임·기수 인수나 공개 정책 승인으로 세지 않는다.
  for (let index = 0; index < 20; index++) {
    signal.throwIfAborted();
    const email = randomUUID() + '@example.test';
    sensitive.add(email);
    const user = await db.user.create({ data: { email, passwordHash } });
    const session = newSession(Date.now());
    sensitive.add(session.token);
    await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [user.id]);
    const gatePid = Number((await gate.query('SELECT pg_backend_pid()::int AS pid')).rows[0]!.pid);
    expect(Number.isSafeInteger(gatePid) && gatePid > 0, '자기 gate backend PID').toBe(true);
    const beforeWaits = await gate.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=$1 AND pid<>$2 AND wait_event_type='Lock'",
      [name, gatePid],
    );
    expect(beforeWaits.rows, '요청 전 다른 잠금 대기 없음').toHaveLength(0);
    const login = call(address, 'auth.login', { email, password }, signal);
    const withdraw = withdrawAccount(db, {
      userId: user.id,
      sessionId: session.id,
      password,
      dummyPasswordHash: passwordHash,
    });
    const settling = Promise.allSettled([login, withdraw]);
    // 두 실제 트랜잭션의 잠금 대기를 관측한 뒤 gate를 해제한다.
    // 관측 실패도 자식 작업을 정착시키고 rollback 오류와 함께 보존한다.
    const failures: unknown[] = [];
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        signal.throwIfAborted();
        await gate.query('SELECT pg_stat_clear_snapshot()');
        const waiting = await gate.query(
          `WITH RECURSIVE waiters AS (
            SELECT pid FROM pg_stat_activity
            WHERE datname=$1 AND pid<>$2 AND wait_event_type='Lock'
          ), paths(root,pid,chain) AS (
            SELECT pid,pid,ARRAY[pid] FROM waiters
            UNION ALL
            SELECT paths.root,blocker.pid,paths.chain || blocker.pid
            FROM paths CROSS JOIN LATERAL unnest(pg_blocking_pids(paths.pid)) AS blocker(pid)
            WHERE blocker.pid>0 AND NOT blocker.pid=ANY(paths.chain) AND cardinality(paths.chain)<16
          )
          SELECT DISTINCT root::int AS pid FROM paths WHERE pid=$2 ORDER BY pid`,
          [name, gatePid],
        );
        signal.throwIfAborted();
        const requestPids = new Set(waiting.rows.map((row) => Number(row.pid)));
        expect([...requestPids].every((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== gatePid)).toBe(true);
        if (requestPids.size === 2) break;
        if (Date.now() >= deadline) throw new Error('두 실제 계정 잠금 대기를 확인하지 못했습니다.');
        await delay(10, undefined, { signal });
      }
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await gate.query('ROLLBACK');
      } catch (error) {
        failures.push(error);
      }
    }
    const results = await settling;
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, '로그인·탈퇴 경합 gate 해제 실패');
    expect(results[1]!.status).toBe('fulfilled');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('WITHDRAWN');
    expect((await records(user.id)).length, '남은 기록 수').toBe(0);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.accountToken.count({ where: { userId: user.id } })).toBe(0);
    expect(results[0]!.status).toBe('fulfilled');
    if (results[0]!.status === 'fulfilled') expect([200, 401]).toContain(results[0]!.value.status);
  }
}, 120_000);
