import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { appRouter } from '../apps/server/src/router';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { authenticate, newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { createSanction, liftSanction } from '../apps/server/src/admin/sanctionStore';
import { changeAdminRole } from '../apps/server/src/admin/roleStore';
import { testDatabaseUrl } from './test-database';
import { initializeResources } from './init-resources';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { processInputs } from '../apps/engine/src/inputs';

type Pg = {
  on(event: 'notification', listener: (message: { channel: string; payload?: string }) => void): void;
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Pg;
};
if (!process.env.TEST_DATABASE_URL) throw new Error('전용 테스트 DB가 필요합니다.');
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('loopback 시험 서버가 필요합니다.');
for (const key of source.searchParams.keys())
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    throw new Error('접속 대상 질의 인자는 쓸 수 없습니다.');
const name = `t305_sanction_${randomUUID().replaceAll('-', '')}_test`;
const adminUrl = new URL(source),
  target = new URL(source);
adminUrl.pathname = '/postgres';
target.pathname = '/' + name;
const admin = new Client({ connectionString: adminUrl.href }),
  client = new Client({ connectionString: target.href });
const db = createDb(target.href);
const now = Date.now(),
  origin = 'http://127.0.0.1:5173';
const executions = new Set<Promise<unknown>>(),
  errors: unknown[] = [];
let app: Awaited<ReturnType<typeof buildServer>> | undefined,
  address: string,
  created = false,
  oid: unknown;
let beforeCatalog: Record<string, unknown>[] = [],
  passwordHash: string;
const password = randomUUID(),
  closedSessions: string[] = [],
  worlds: string[] = [];
let formal:
  | {
      worldId: string;
      otherWorld: string;
      humanId: number;
      dueTick: number;
      actorId: string;
      victimId: string;
      sanctionId: string;
      otherRows: Awaited<ReturnType<typeof db.generalTurn.findMany>>;
      humanRows: Awaited<ReturnType<typeof db.generalTurn.findMany>>;
    }
  | undefined;
function track<T>(action: () => Promise<T>) {
  const promise = Promise.resolve().then(action);
  executions.add(promise);
  void promise.then(
    () => executions.delete(promise),
    (error) => {
      errors.push(error);
      executions.delete(promise);
    },
  );
  return promise;
}
function it(title: string, action: () => Promise<void>) {
  test(title, () => track(action));
}
async function advanceRenewing(worldId: string, tick: number) {
  const lease = await acquireLease(db, worldId);
  expect(lease).not.toBeNull();
  const stop = new AbortController(),
    failures: unknown[] = [];
  const heartbeat = (async () => {
    while (!stop.signal.aborted) {
      try {
        await delay(3000, undefined, { signal: stop.signal });
      } catch {
        if (stop.signal.aborted) break;
        throw new Error('리스 갱신 대기 실패');
      }
      if (!stop.signal.aborted) await renewLease(db, lease!);
    }
  })();
  void heartbeat.catch((error) => {
    failures.push(error);
    stop.abort();
  });
  let result: Awaited<ReturnType<TurnLoop['advanceTo']>> = [];
  try {
    result = await new TurnLoop(db, lease!).advanceTo(tick, stop.signal);
  } catch (error) {
    failures.push(error);
  } finally {
    stop.abort();
    await heartbeat.catch(() => undefined);
    try {
      await releaseLease(db, lease!);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError([...new Set(failures)], '예약 실행·리스 갱신 실패');
  return result;
}
async function settle() {
  while (executions.size) await Promise.allSettled([...executions]);
}
const catalog = async () =>
  (await admin.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows;
beforeEach(settle);
async function user(
  role: 'USER' | 'ADMIN' = 'USER',
  status: 'ACTIVE' | 'SANCTIONED' | 'WITHDRAWN' = 'ACTIVE',
  verified = true,
) {
  return db.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      passwordHash,
      role,
      status,
      emailVerifiedAt: verified ? new Date(now) : null,
    },
  });
}
async function session(userId: string) {
  const value = newSession(now);
  await db.session.create({ data: { id: value.id, userId, expiresAt: value.expiresAt } });
  return { ...value, cookie: `sid=${value.token}` };
}
async function call(path: string, input: unknown, cookie?: string, base = address) {
  const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
  const mutation = procedures[path]!._def.type === 'mutation',
    encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${base}/trpc/${path}?batch=1${mutation ? '' : '&input=' + encodeURIComponent(encoded)}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const raw = await response.text();
  const [body] = JSON.parse(raw) as Array<{
    result?: { data: unknown };
    error?: { data: { code: string; reason: string | null } };
  }>;
  return {
    raw,
    status: response.status,
    data: body!.result?.data,
    code: body!.error?.data.code,
    reason: body!.error?.data.reason,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function snapshot() {
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const hash = createHash('sha256');
  for (const { tablename } of tables) {
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const rows = await db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t`,
    );
    hash.update(tablename + '\n' + rows[0]!.body + '\n');
  }
  return hash.digest('hex');
}
beforeAll(
  () =>
    track(async () => {
      await admin.connect();
      beforeCatalog = await catalog();
      expect(beforeCatalog.some((row) => row.datname === name)).toBe(false);
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      oid = (await catalog()).find((row) => row.datname === name)?.oid;
      expect(typeof oid).toBe('string');
      await client.connect();
      client.on('notification', (message) => {
        if (message.channel === 'sessions_closed' && message.payload) closedSessions.push(message.payload);
      });
      await client.query('LISTEN sessions_closed');
      const root = new URL('../packages/db/prisma/migrations/', import.meta.url);
      for (const migration of (await readdir(root)).filter((value) => /^\d{14}_/.test(value)).sort())
        await client.query(await readFile(new URL(migration + '/migration.sql', root), 'utf8'));
      await initializeResources(
        db,
        await readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
      );
      passwordHash = await hashPassword(password);
      app = await buildServer({
        db,
        now: () => now,
        logging: false,
        publicOrigin: origin,
        emailVerificationRequired: true,
      });
      address = await app.listen({ host: '127.0.0.1', port: randomInt(20_000, 50_000) });
    }),
  30_000,
);
afterAll(async () => {
  await settle();
  for (const close of [() => app?.close(), () => client.end(), () => db.$disconnect()]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  let connections: number | null = null,
    dropped = false;
  try {
    if (created) {
      expect((await catalog()).find((row) => row.datname === name)).toEqual({ datname: name, oid });
      for (let i = 0; i <= 20; i++) {
        connections = Number(
          (await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]!
            .count,
        );
        if (!connections || i === 20) break;
        await delay(50);
      }
      expect(connections).toBe(0);
      expect((await catalog()).find((row) => row.datname === name)).toEqual({ datname: name, oid });
      if (!errors.length) {
        await admin.query(`DROP DATABASE "${name}"`);
        dropped = true;
        expect(await catalog()).toEqual(beforeCatalog);
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
  console.info(
    JSON.stringify({ event: 't305-sanction-cleanup', name, oid, connections, dropped, errors: errors.length }),
  );
  if (errors.length) throw new AggregateError([...new Set(errors)], '제재 실행·정리 실패');
});

for (const path of ['admin.sanction.create', 'admin.sanction.lift', 'sanction.mine'])
  for (const category of categories)
    it(
      `${path} ${category}`,
      authzCase(path, category, async () => {
        const actor = await user(
          path === 'sanction.mine' || category === 'otherUser' ? 'USER' : 'ADMIN',
          category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE',
        );
        const victim = await user(),
          sid = category === 'unauthenticated' ? undefined : (await session(actor.id)).cookie;
        let input: unknown;
        if (path.endsWith('create'))
          input = { userId: victim.id, worldId: null, reason: '전용 권한 시험', expiresAt: null };
        if (path.endsWith('lift')) {
          const row = await db.sanction.create({
            data: { userId: victim.id, createdBy: actor.id, reason: '전용 권한 시험' },
          });
          input = { sanctionId: row.id, reason: '해제 시험' };
        }
        if (category === 'invalidInput' || (path === 'sanction.mine' && category === 'otherUser'))
          input = { userId: victim.id };
        const before = await snapshot(),
          result = await call(path, input, sid);
        if (category === 'success') {
          expect(result.status).toBe(200);
          if (path === 'sanction.mine') {
            expect(result.data).toEqual([]);
            expect(await snapshot()).toBe(before);
          }
        } else {
          expect(result.code).toBe(
            category === 'invalidInput' || (path === 'sanction.mine' && category === 'otherUser')
              ? 'BAD_REQUEST'
              : category === 'otherUser'
                ? 'FORBIDDEN'
                : 'UNAUTHORIZED',
          );
          expect(result.reason).toBe(null);
          expect(await snapshot()).toBe(before);
        }
      }),
    );

it('관리자 본인·다른 관리자·미인증 관리자·위조 권한과 만료/사유 오류를 거부한다', async () => {
  const actor = await user('ADMIN'),
    other = await user('ADMIN'),
    unverified = await user('ADMIN', 'ACTIVE', false),
    victim = await user();
  const sid = (await session(actor.id)).cookie,
    unverifiedSid = (await session(unverified.id)).cookie;
  const base = { userId: victim.id, worldId: null, reason: '시험 사유', expiresAt: null };
  for (const userId of [actor.id, other.id]) {
    const before = await snapshot();
    expect((await call('admin.sanction.create', { ...base, userId }, sid)).code).toBe('FORBIDDEN');
    expect(await snapshot()).toBe(before);
  }
  for (const input of [
    { ...base, reason: ' ' },
    { ...base, reason: '가'.repeat(201) },
    { ...base, expiresAt: new Date(now).toISOString() },
    { ...base, worldId: 1 },
    { ...base, role: 'ADMIN' },
  ]) {
    const before = await snapshot();
    expect((await call('admin.sanction.create', input, sid)).code).toBe('BAD_REQUEST');
    expect(await snapshot()).toBe(before);
  }
  const before = await snapshot();
  expect((await call('admin.sanction.create', base, unverifiedSid)).reason).toBe('EMAIL_NOT_VERIFIED');
  expect(await snapshot()).toBe(before);
});

it('같은 제재 요청은 순차·동시 재확인해도 한 번 확정하고 다른 내용은 거부한다', async () => {
  const actor = await user('ADMIN'),
    victim = await user(),
    sid = await session(actor.id);
  await session(victim.id);
  const input = {
    userId: victim.id,
    worldId: null,
    reason: '  응답 유실 재확인  ',
    expiresAt: new Date(now + 60_000).toISOString(),
    expectedUserId: actor.id,
    idempotencyKey: randomUUID(),
  };
  const settled = await Promise.allSettled(
    Array.from({ length: 3 }, () => call('admin.sanction.create', input, sid.cookie)),
  );
  const rejected = settled.filter((result) => result.status === 'rejected');
  if (rejected.length)
    throw new AggregateError(
      rejected.map((result) => result.reason),
      '동시 제재 요청 정착 실패',
    );
  const results = settled.map((result) => {
    if (result.status !== 'fulfilled') throw new Error('동시 요청이 정착하지 않았습니다.');
    return result.value;
  });
  for (const result of results) expect(result.status).toBe(200);
  expect(results[0]!.data).toEqual(results[1]!.data);
  expect(results[1]!.data).toEqual(results[2]!.data);
  expect(await db.sanction.count({ where: { userId: victim.id } })).toBe(1);
  expect(await db.auditLog.count({ where: { actorUserId: actor.id, action: 'sanction.create' } })).toBe(1);
  expect(await db.adminSanctionRequest.count({ where: { actorUserId: actor.id } })).toBe(1);
  expect(await db.session.count({ where: { userId: victim.id } })).toBe(0);
  await session(victim.id);
  await db.user.update({ where: { id: victim.id }, data: { status: 'WITHDRAWN', role: 'ADMIN' } });
  const before = await snapshot();
  const retry = await call('admin.sanction.create', { ...input, reason: input.reason.trim() }, sid.cookie);
  expect(retry.status).toBe(200);
  expect(retry.data).toEqual(results[0]!.data);
  expect(await snapshot()).toBe(before);
  expect((await call('admin.sanction.create', { ...input, reason: '다른 사유' }, sid.cookie)).code).toBe('CONFLICT');
  expect((await call('admin.sanction.create', { ...input, userId: randomUUID() }, sid.cookie)).code).toBe('CONFLICT');
  expect((await call('admin.sanction.create', { ...input, worldId: randomUUID() }, sid.cookie)).code).toBe('CONFLICT');
  expect(await snapshot()).toBe(before);
  // 원래 성공의 만료 시각이 지난 뒤에도 같은 receipt를 읽는다. 입력의 만료 시각은 바꾸지 않는다.
  const late = await createSanction(db, actor.id, input, now + 120_000);
  expect({ sanctionId: late.sanctionId }).toEqual(results[0]!.data);
  expect(late.closedSessionIds).toEqual([]);
  expect(await snapshot()).toBe(before);
});

it('A 본인 조회 뒤 B 관리자 세션의 기대 A 입력과 위조 필드는 어떤 조치도 쓰지 않는다', async () => {
  const a = await user('ADMIN'),
    b = await user('ADMIN'),
    victim = await user(),
    aSid = await session(a.id),
    bSid = await session(b.id);
  expect((await call('auth.me', undefined, aSid.cookie)).status).toBe(200);
  const sanction = await db.sanction.create({ data: { userId: victim.id, createdBy: a.id, reason: '기존 제재' } });
  const input = { userId: victim.id, worldId: null, reason: '신원 확인', expiresAt: null };
  const before = await snapshot();
  expect(
    (await call('admin.sanction.create', { ...input, expectedUserId: a.id, idempotencyKey: randomUUID() }, bSid.cookie))
      .code,
  ).toBe('UNAUTHORIZED');
  expect(
    (await call('admin.sanction.lift', { sanctionId: sanction.id, reason: '해제', expectedUserId: a.id }, bSid.cookie))
      .code,
  ).toBe('UNAUTHORIZED');
  for (const extra of [{ expectedUserId: 'bad' }, { idempotencyKey: 'bad' }, { actorUserId: a.id }])
    expect((await call('admin.sanction.create', { ...input, ...extra }, bSid.cookie)).code).toBe('BAD_REQUEST');
  expect(await snapshot()).toBe(before);
});

it('receipt 쓰기 실패는 제재·감사·세션 삭제를 모두 되돌리고 공개 오류 원문을 숨긴다', async () => {
  const actor = await user('ADMIN'),
    victim = await user(),
    sid = await session(actor.id);
  await session(victim.id);
  const failures: unknown[] = [];
  await client.query(
    `CREATE FUNCTION t305_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-receipt-failure'; END $$`,
  );
  try {
    await client.query(
      'CREATE TRIGGER t305_fail_receipt BEFORE INSERT ON "AdminSanctionRequest" FOR EACH ROW EXECUTE FUNCTION t305_fail_receipt()',
    );
    try {
      const before = await snapshot();
      const response = await call(
        'admin.sanction.create',
        {
          userId: victim.id,
          worldId: null,
          reason: '원자성',
          expiresAt: null,
          expectedUserId: actor.id,
          idempotencyKey: randomUUID(),
        },
        sid.cookie,
      );
      expect(response.code).toBe('INTERNAL_SERVER_ERROR');
      expect(response.raw.includes('private-receipt-failure')).toBe(false);
      expect(await snapshot()).toBe(before);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await client.query('DROP TRIGGER t305_fail_receipt ON "AdminSanctionRequest"');
      } catch (error) {
        failures.push(error);
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await client.query('DROP FUNCTION t305_fail_receipt()');
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'receipt 원자성 본문·정리 실패');
});

it('두 관리자의 반대 대상 동시 제재는 교착 없이 모두 거부한다', async () => {
  const a = await user('ADMIN'),
    b = await user('ADMIN'),
    aSid = await session(a.id),
    bSid = await session(b.id),
    before = await snapshot();
  const jobs: Array<ReturnType<typeof call>> = [],
    failures: unknown[] = [];
  let begun = false;
  try {
    await client.query('BEGIN');
    begun = true;
    const gatePid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
    await client.query('SELECT id FROM "User" WHERE id=$1 FOR SHARE', [[a.id, b.id].sort()[0]]);
    jobs.push(
      call(
        'admin.sanction.create',
        {
          userId: b.id,
          worldId: null,
          reason: '교차 A',
          expiresAt: null,
          expectedUserId: a.id,
          idempotencyKey: randomUUID(),
        },
        aSid.cookie,
      ),
    );
    jobs.push(
      call(
        'admin.sanction.create',
        {
          userId: a.id,
          worldId: null,
          reason: '교차 B',
          expiresAt: null,
          expectedUserId: b.id,
          idempotencyKey: randomUUID(),
        },
        bSid.cookie,
      ),
    );
    for (const job of jobs) void job.catch(() => undefined);
    await expect
      .poll(async () =>
        Number(
          (
            await admin.query(
              `WITH RECURSIVE blocked AS (
                  SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
                  WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%ORDER BY id FOR UPDATE%'
                ), chain AS (
                  SELECT pid AS root,unnest(blockers) AS blocker FROM blocked
                  UNION
                  SELECT root,unnest(pg_blocking_pids(blocker)) FROM chain WHERE blocker<>$2
                ) SELECT count(DISTINCT root)::int AS n FROM chain WHERE blocker=$2`,
              [name, gatePid],
            )
          ).rows[0]!.n,
        ),
      )
      .toBe(2);
    await client.query('COMMIT');
    begun = false;
    const results = await Promise.allSettled(jobs);
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') expect(result.value.code).toBe('FORBIDDEN');
    }
    expect(await snapshot()).toBe(before);
  } catch (error) {
    failures.push(error);
  } finally {
    if (begun) {
      try {
        await client.query('ROLLBACK');
      } catch (error) {
        failures.push(error);
      }
    }
    for (const result of await Promise.allSettled(jobs)) if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError([...new Set(failures)], '교차 제재 경합·정착·정리 실패');
});

for (const operation of ['create', 'lift'] as const)
  for (const mode of ['role', 'session-delete', 'session-expiry', 'email', 'sanction', 'consent'] as const)
    it(`실제 대상 잠금 대기 뒤 관리자 ${mode} 변경은 ${operation} 쓰기를 거부한다`, async () => {
      const one = await user(),
        two = await user();
      const [victim, actor] = [one, two].sort((a, b) => (a.id < b.id ? -1 : 1));
      await db.user.update({ where: { id: actor!.id }, data: { role: 'ADMIN' } });
      const sid = await session(actor!.id);
      const policy = {
        terms: { version: 'sanction-lock-test', effectiveAt: new Date(now - 1000).toISOString() },
        privacy: { version: 'sanction-lock-test', effectiveAt: new Date(now - 1000).toISOString() },
      };
      let policyServer: Awaited<ReturnType<typeof buildServer>> | undefined,
        base = address,
        pending: ReturnType<typeof call> | undefined,
        begun = false;
      const failures: unknown[] = [];
      try {
        if (mode === 'consent') {
          policyServer = await buildServer({
            db,
            logging: false,
            now: () => now,
            publicOrigin: origin,
            emailVerificationRequired: true,
            legalPolicy: policy,
          });
          base = await policyServer.listen({ host: '127.0.0.1', port: randomInt(20_000, 50_000) });
          for (const docType of ['TERMS', 'PRIVACY'])
            expect(
              (await call('legal.agree', { docType, version: 'sanction-lock-test' }, sid.cookie, base)).status,
            ).toBe(200);
        }
        const existing =
          operation === 'lift'
            ? await db.sanction.create({ data: { userId: victim!.id, createdBy: actor!.id, reason: '기존 제재' } })
            : null;
        const input =
          operation === 'create'
            ? {
                userId: victim!.id,
                worldId: null,
                reason: '대기 중 생성',
                expiresAt: null,
                expectedUserId: actor!.id,
                idempotencyKey: randomUUID(),
              }
            : { sanctionId: existing!.id, reason: '대기 중 해제', expectedUserId: actor!.id };
        await client.query('BEGIN');
        begun = true;
        const gatePid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
        await client.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [victim!.id]);
        pending = call('admin.sanction.' + operation, input, sid.cookie, base);
        void pending.catch(() => undefined);
        await expect
          .poll(async () =>
            Number(
              (
                await admin.query(
                  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%ORDER BY id FOR UPDATE%' AND $2=ANY(pg_blocking_pids(pid))",
                  [name, gatePid],
                )
              ).rows[0]!.n,
            ),
          )
          .toBe(1);
        if (mode === 'role') await client.query('UPDATE "User" SET role=\'USER\' WHERE id=$1', [actor!.id]);
        if (mode === 'email') await client.query('UPDATE "User" SET "emailVerifiedAt"=NULL WHERE id=$1', [actor!.id]);
        if (mode === 'session-delete') await client.query('DELETE FROM "Session" WHERE id=$1', [sid.id]);
        if (mode === 'session-expiry')
          await client.query('UPDATE "Session" SET "expiresAt"=now()-interval \'1 minute\' WHERE id=$1', [sid.id]);
        if (mode === 'consent') await client.query('DELETE FROM "ConsentRecord" WHERE "userId"=$1', [actor!.id]);
        if (mode === 'sanction')
          await client.query('INSERT INTO "Sanction" (id,"userId",reason,"createdBy") VALUES ($1,$2,$3,$2)', [
            randomUUID(),
            actor!.id,
            '대기 중 전체 제재',
          ]);
        // 변경은 아직 잠금 안에 있다. 같은 연결의 전체 행 snapshot을 확정 직후 기준으로 쓴다.
        const before = await snapshotFrom(client);
        await client.query('COMMIT');
        begun = false;
        const response = await pending;
        expect(response.code).toBe(
          mode === 'role' || mode === 'email' || mode === 'consent' ? 'FORBIDDEN' : 'UNAUTHORIZED',
        );
        expect(response.reason).toBe(
          mode === 'email' ? 'EMAIL_NOT_VERIFIED' : mode === 'consent' ? 'CONSENT_REQUIRED' : null,
        );
        expect(await snapshot()).toBe(before);
      } catch (error) {
        failures.push(error);
      } finally {
        if (begun) {
          try {
            await client.query('ROLLBACK');
          } catch (error) {
            failures.push(error);
          }
        }
        if (pending) {
          const [result] = await Promise.allSettled([pending]);
          if (result!.status === 'rejected') failures.push(result!.reason);
        }
        try {
          await policyServer?.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError([...new Set(failures)], '제재 대기 본문·요청 정착·정리 실패');
    });

async function snapshotFrom(connection: Pg) {
  const tables = (
    await connection.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  ).rows;
  const hash = createHash('sha256');
  for (const row of tables) {
    const table = String(row.tablename),
      quoted = '"' + table.replaceAll('"', '""') + '"';
    const result = await connection.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t`,
    );
    hash.update(table + '\n' + result.rows[0]!.body + '\n');
  }
  return hash.digest('hex');
}

it('전체 제재는 모든 세션을 지우고 재로그인·갱신을 막으며 해제 뒤 다시 로그인한다', async () => {
  const actor = await user('ADMIN'),
    victim = await user(),
    adminSid = (await session(actor.id)).cookie;
  const one = await session(victim.id),
    two = await session(victim.id);
  const result = await call(
    'admin.sanction.create',
    { userId: victim.id, worldId: null, reason: '전체 시험', expiresAt: null },
    adminSid,
  );
  expect(result.status).toBe(200);
  const sanctionId = (result.data as { sanctionId: string }).sanctionId;
  expect(await db.session.count({ where: { userId: victim.id } })).toBe(0);
  expect(await authenticate(db, one.token, now)).toBe(null);
  expect((await call('auth.login', { email: victim.email, password })).code).toBe('UNAUTHORIZED');
  const forced = await session(victim.id);
  expect(await authenticate(db, forced.token, now, false)).toBe(null);
  await db.session.update({ where: { id: forced.id }, data: { expiresAt: new Date(now + 1000) } });
  expect(await authenticate(db, forced.token, now)).toBe(null);
  expect((await db.session.findUniqueOrThrow({ where: { id: forced.id } })).expiresAt.getTime()).toBe(now + 1000);
  expect((await call('sanction.mine', undefined, two.cookie)).code).toBe('UNAUTHORIZED');
  expect((await call('admin.sanction.lift', { sanctionId, reason: '해제 시험' }, adminSid)).data).toEqual({ ok: true });
  expect((await call('auth.login', { email: victim.email, password })).status).toBe(200);
  const first = await db.sanction.findUniqueOrThrow({ where: { id: sanctionId } });
  expect((await call('admin.sanction.lift', { sanctionId, reason: '해제 재요청' }, adminSid)).status).toBe(200);
  expect(await db.sanction.findUnique({ where: { id: sanctionId } })).toEqual(first);
  expect(
    (
      await db.auditLog.findFirstOrThrow({
        where: { action: 'sanction.lift', targetId: victim.id },
        orderBy: { id: 'desc' },
      })
    ).payload,
  ).toMatchObject({ changed: false });
  await expect.poll(() => closedSessions.includes(one.id) && closedSessions.includes(two.id)).toBe(true);
});

it('만료된 제재는 세션과 로그인을 막지 않으며 ADMIN 승격은 유효한 모든 제재를 거부한다', async () => {
  const actor = await user('ADMIN'),
    victim = await user(),
    value = await session(victim.id);
  await db.sanction.create({
    data: { userId: victim.id, reason: '만료 시험', createdBy: actor.id, expiresAt: new Date(now) },
  });
  expect(await authenticate(db, value.token, now, false)).not.toBe(null);
  expect((await call('auth.login', { email: victim.email, password })).status).toBe(200);
  const current = await createSanction(
    db,
    actor.id,
    { userId: victim.id, worldId: null, reason: '승격 차단', expiresAt: null },
    now,
  );
  await expect(changeAdminRole(db, { email: victim.email, role: 'ADMIN', reason: '승격 시험' })).rejects.toThrow(
    '먼저 해제',
  );
  expect((await db.user.findUniqueOrThrow({ where: { id: victim.id } })).role).toBe('USER');
  await liftSanction(db, actor.id, { sanctionId: current.sanctionId, reason: '승격 전 해제' }, now);
  expect((await changeAdminRole(db, { email: victim.email, role: 'ADMIN', reason: '해제 후 승격' })).role).toBe(
    'ADMIN',
  );
});

it('역할 부여와 제재 생성의 경쟁은 제재된 ADMIN을 만들지 않는다', async () => {
  const actor = await user('ADMIN');
  for (let i = 0; i < 4; i++) {
    const victim = await user();
    const results = await Promise.allSettled([
      changeAdminRole(db, { email: victim.email, role: 'ADMIN', reason: '동시 승격' }),
      createSanction(db, actor.id, { userId: victim.id, worldId: null, reason: '동시 제재', expiresAt: null }, now),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const row = await db.user.findUniqueOrThrow({ where: { id: victim.id } });
    const count = await db.sanction.count({ where: { userId: victim.id, liftedAt: null } });
    expect({ role: row.role, count }).toEqual(
      row.role === 'ADMIN' ? { role: 'ADMIN', count: 0 } : { role: 'USER', count: 1 },
    );
  }
});

it('DB는 해제 사유 NULL·빈 문자열과 대상 삭제를 거부한다', async () => {
  const actor = await user('ADMIN'),
    victim = await user();
  const current = await createSanction(
    db,
    actor.id,
    { userId: victim.id, worldId: null, reason: '사유 제약 시험', expiresAt: null },
    now,
  );
  const before = await snapshot();
  for (const reason of [null, '', ' ']) {
    await expect(
      db.$executeRaw`UPDATE "Sanction" SET "liftedAt"=${new Date(now)},"liftedBy"=${actor.id},"liftReason"=${reason} WHERE id=${current.sanctionId}`,
    ).rejects.toThrow();
    expect(await snapshot()).toBe(before);
  }
  await expect(db.user.delete({ where: { id: victim.id } })).rejects.toThrow();
  expect(await snapshot()).toBe(before);
});

it('감사 INSERT 실패는 제재·세션 삭제와 해제까지 함께 롤백한다', async () => {
  const actor = await user('ADMIN'),
    victim = await user();
  await session(victim.id);
  const existing = await createSanction(
    db,
    actor.id,
    { userId: victim.id, worldId: null, reason: '기존 시험', expiresAt: null },
    now,
  );
  await session(victim.id);
  await db.$executeRawUnsafe(
    `CREATE FUNCTION t305_fail_sanction_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'sanction.%' THEN RAISE EXCEPTION 'controlled audit failure'; END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    'CREATE TRIGGER t305_fail_sanction_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION t305_fail_sanction_audit()',
  );
  try {
    const before = await snapshot();
    await expect(
      createSanction(
        db,
        actor.id,
        { userId: victim.id, worldId: null, reason: '실패 시험', expiresAt: null, idempotencyKey: randomUUID() },
        now,
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toBe(before);
    await expect(
      liftSanction(db, actor.id, { sanctionId: existing.sanctionId, reason: '실패 해제' }, now),
    ).rejects.toThrow();
    expect(await snapshot()).toBe(before);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER t305_fail_sanction_audit ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION t305_fail_sanction_audit()');
  }
});

it('제재 트랜잭션 뒤 대기 중이던 실제 로그인은 새 세션을 만들지 못한다', async () => {
  const actor = await user('ADMIN'),
    victim = await user();
  const suffix = randomUUID().replaceAll('-', ''),
    createName = 't305_create_' + suffix,
    loginName = 't305_login_' + suffix;
  const named = (applicationName: string) => {
    const url = new URL(target);
    url.searchParams.set('application_name', applicationName);
    return createDb(url.href);
  };
  const createDbClient = named(createName),
    loginDb = named(loginName);
  let loginApp: Awaited<ReturnType<typeof buildServer>> | undefined;
  const key = Math.floor(Math.random() * 2_000_000_000);
  const pending: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  let held = false,
    trigger = false;
  async function waitLocked(applicationName: string) {
    await expect
      .poll(async () => {
        const rows = await db.$queryRaw<
          Array<{ waiting: boolean }>
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${applicationName} AND wait_event_type='Lock' AND state='active') AS waiting`;
        return rows[0]!.waiting;
      })
      .toBe(true);
  }
  try {
    await client.query('SELECT pg_advisory_lock(305,$1)', [key]);
    held = true;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION t305_pause_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='sanction.create' AND NEW."targetId"='${victim.id}' THEN PERFORM pg_advisory_xact_lock(305,${key}); END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER t305_pause_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION t305_pause_audit()',
    );
    trigger = true;
    loginApp = await buildServer({ db: loginDb, logging: false, now: () => now, publicOrigin: origin });
    const loginAddress = await loginApp.listen({ host: '127.0.0.1', port: randomInt(20_000, 50_000) });
    const creating = createSanction(
      createDbClient,
      actor.id,
      { userId: victim.id, worldId: null, reason: '로그인 경쟁 제재', expiresAt: null },
      now,
    );
    pending.push(creating);
    void creating.catch(() => undefined);
    await waitLocked(createName);
    const loggingIn = fetch(loginAddress + '/trpc/auth.login?batch=1', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ 0: { email: victim.email, password } }),
      signal: AbortSignal.timeout(10_000),
    }).then(async (response) => ({
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie'),
    }));
    pending.push(loggingIn);
    void loggingIn.catch(() => undefined);
    await waitLocked(loginName);
    await client.query('SELECT pg_advisory_unlock(305,$1)', [key]);
    held = false;
    await creating;
    const result = await loggingIn;
    expect(result.status).toBe(401);
    expect(result.body[0].error.data.code).toBe('UNAUTHORIZED');
    expect(result.cookie).toBe(null);
    expect(await db.session.count({ where: { userId: victim.id } })).toBe(0);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (held) await client.query('SELECT pg_advisory_unlock(305,$1)', [key]);
    } catch (error) {
      failures.push(error);
    }
    const results = await Promise.allSettled(pending);
    const cleanup = await Promise.allSettled([loginApp?.close(), createDbClient.$disconnect(), loginDb.$disconnect()]);
    for (const cleanup of [
      async () => {
        if (trigger) await db.$executeRawUnsafe('DROP TRIGGER t305_pause_audit ON "AuditLog"');
      },
      () => db.$executeRawUnsafe('DROP FUNCTION IF EXISTS t305_pause_audit()'),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    const rejected = [...results, ...cleanup].filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    failures.push(...rejected.map((result) => result.reason));
  }
  if (failures.length) throw new AggregateError([...new Set(failures)], '로그인 경쟁 실행·정리 실패');
});

it('정식 두191년 월드에서21개 변경 차단·본인 조회·같은 월드 타인과 다른 월드 예약을 보존한다', async () => {
  const actor = await user('ADMIN'),
    victim = await user(),
    other = await user();
  const sid = (await session(victim.id)).cookie,
    otherSid = (await session(other.id)).cookie;
  const initial = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'sanction-formal-191',
  });
  initial.ruleFeatures = [
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
  for (const name of ['제재 월드', '허용 월드']) {
    const saved = await saveInitialWorld(db, initial, { name, turnTermMinutes: 60, endYear: 201 });
    worlds.push(saved.worldId);
    await controlClock(db, saved.worldId, 'start');
    const pending = track(() =>
      call(
        'general.create',
        {
          worldId: saved.worldId,
          name: '제재시험장수',
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
          portraitId: null,
        },
        sid,
      ),
    );
    await expect
      .poll(() =>
        db.inputEvent.count({
          where: { worldId: saved.worldId, userId: victim.id, kind: 'general.create', status: 'PENDING' },
        }),
      )
      .toBe(1);
    const lease = await acquireLease(db, saved.worldId);
    expect(lease).not.toBeNull();
    try {
      await new TurnLoop(db, lease!).advanceTo(0);
    } finally {
      await releaseLease(db, lease!);
    }
    expect((await pending).status).toBe(200);
    if (name === '제재 월드') {
      const otherPending = track(() =>
        call(
          'general.create',
          {
            worldId: saved.worldId,
            name: '같은월드타인',
            leadership: 55,
            strength: 55,
            intel: 55,
            politics: 55,
            charm: 55,
            portraitId: null,
          },
          otherSid,
        ),
      );
      await expect
        .poll(() =>
          db.inputEvent.count({
            where: {
              worldId: saved.worldId,
              userId: other.id,
              kind: 'general.create',
              status: 'PENDING',
            },
          }),
        )
        .toBe(1);
      await advanceRenewing(saved.worldId, 0);
      expect((await otherPending).status).toBe(200);
    }
    expect(await db.general.count({ where: { worldId: saved.worldId, userId: null } })).toBe(491);
  }
  const worldId = worlds[0]!,
    otherWorld = worlds[1]!;
  const slots = Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {} }));
  expect((await call('turns.set', { worldId, revision: 0, slots }, sid)).status).toBe(200);
  const otherSlots = Array.from({ length: 30 }, (_, index) => ({ commandKey: index % 2 ? 'train' : 'farm', args: {} }));
  expect((await call('turns.set', { worldId, revision: 0, slots: otherSlots }, otherSid)).status).toBe(200);
  const peer = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: other.id } } });
  const peerRows = await db.generalTurn.findMany({ where: { worldId, generalId: peer.id }, orderBy: { slot: 'asc' } });
  expect(peerRows).toHaveLength(30);
  expect(peerRows.map(({ commandKey, args }) => ({ commandKey, args }))).toEqual(otherSlots);
  const human = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: victim.id } } });
  const priorSlots = await db.generalTurn.findMany({
    where: { worldId, generalId: human.id },
    orderBy: { slot: 'asc' },
  });
  expect(priorSlots).toHaveLength(30);
  const accepted = await db.inputEvent.findMany({ where: { worldId, userId: victim.id }, orderBy: { id: 'asc' } });
  const current = await createSanction(
    db,
    actor.id,
    { userId: victim.id, worldId, reason: '해당 월드 제한', expiresAt: null },
    now,
  );
  expect(await db.generalTurn.findMany({ where: { worldId, generalId: human.id }, orderBy: { slot: 'asc' } })).toEqual(
    priorSlots,
  );
  expect(await db.inputEvent.findMany({ where: { worldId, userId: victim.id }, orderBy: { id: 'asc' } })).toEqual(
    accepted,
  );
  expect(await db.generalTurn.findMany({ where: { worldId, generalId: peer.id }, orderBy: { slot: 'asc' } })).toEqual(
    peerRows,
  );
  const procedures = appRouter._def.procedures as unknown as Record<
    string,
    { _def: { type: string; meta?: { worldSanction?: true } } }
  >;
  const guarded = Object.entries(procedures)
    .filter(([, procedure]) => procedure._def.meta?.worldSanction)
    .map(([path]) => path);
  expect(guarded).toHaveLength(22);
  expect(guarded).toContain('cityResources.allocate');
  // AC-INT-19B: 장수 지시 접수도 월드 제재 대상이다.
  expect(guarded).toContain('campaign.order');
  expect(
    (await db.world.findUniqueOrThrow({ where: { id: worldId }, select: { ruleFeatures: true } })).ruleFeatures,
  ).not.toContain('city-resources-v1');
  const cityInput = {
    worldId,
    requestId: randomUUID(),
    expectedUserId: victim.id,
    payload: { cityKey: human.cityKey, unitId: 1, crewType: 1100, amount: 1 },
  };
  const orderInput = {
    worldId,
    requestId: randomUUID(),
    expectedUserId: victim.id,
    payload: { type: 'request', revision: 0 },
  };
  const inputs: Record<string, unknown> = { 'cityResources.allocate': cityInput, 'campaign.order': orderInput };
  const before = await snapshot();
  for (const path of guarded)
    expect(await call(path, inputs[path] ?? { worldId }, sid)).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      reason: null,
    });
  expect(await snapshot()).toBe(before);
  expect(await db.generalTurn.findMany({ where: { worldId, generalId: peer.id }, orderBy: { slot: 'asc' } })).toEqual(
    peerRows,
  );
  expect((await call('world.summary', { worldId }, sid)).status).toBe(200);
  expect((await call('sanction.mine', undefined, sid)).data).toEqual([
    { worldId, worldName: '제재 월드', reason: '해당 월드 제한', expiresAt: null },
  ]);
  expect((await call('sanction.mine', undefined, otherSid)).data).toEqual([]);
  expect((await call('sanction.mine', { userId: victim.id }, otherSid)).code).toBe('BAD_REQUEST');
  expect((await call('turns.set', { worldId: otherWorld, revision: 0, slots }, sid)).status).toBe(200);
  expect((await call('turns.set', { worldId: 1, revision: 0, slots }, sid)).code).toBe('BAD_REQUEST');
  const otherRows = await db.generalTurn.findMany({
    where: { worldId: otherWorld },
    orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
  });
  formal = {
    worldId,
    otherWorld,
    humanId: human.id,
    dueTick: human.nextTurnTick,
    actorId: actor.id,
    victimId: victim.id,
    sanctionId: current.sanctionId,
    otherRows,
    humanRows: priorSlots,
  };
});

it('제재 전 예약의 실행 시각 전반까지 실제 엔진으로 진행해 사람 예약을 보존한다', async () => {
  expect(formal).toBeDefined();
  const { worldId, humanId, dueTick, humanRows, otherWorld, otherRows } = formal!;
  const halfway = Math.floor(dueTick / 2);
  const executions = await advanceRenewing(worldId, halfway);
  expect(executions.some((row) => row.generalId === humanId)).toBe(false);
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick).toBe(halfway);
  expect(await db.generalTurn.findMany({ where: { worldId, generalId: humanId }, orderBy: { slot: 'asc' } })).toEqual(
    humanRows,
  );
  expect(
    await db.generalTurn.findMany({ where: { worldId: otherWorld }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
  ).toEqual(otherRows);
});

it('제재 전 사람 예약은 실제 실행 시각에 한 번 실행되고 해제 뒤 본인 조회가 갱신된다', async () => {
  expect(formal).toBeDefined();
  const { worldId, humanId, dueTick, actorId, sanctionId, otherWorld, otherRows, victimId } = formal!;
  const executions = await advanceRenewing(worldId, dueTick);
  expect(executions.filter((row) => row.generalId === humanId && row.commandKey === 'rest')).toHaveLength(1);
  expect(
    (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: humanId } } })).nextTurnTick,
  ).toBeGreaterThan(dueTick);
  expect(
    await db.generalTurn.findMany({ where: { worldId: otherWorld }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
  ).toEqual(otherRows);
  await liftSanction(db, actorId, { sanctionId, reason: '월드 해제' }, now);
  expect((await call('sanction.mine', undefined, (await session(victimId)).cookie)).data).toEqual([]);
  await expect(db.user.delete({ where: { id: victimId } })).rejects.toThrow();
  await expect(db.world.delete({ where: { id: worldId } })).rejects.toThrow();
});

it('World를 먼저 잠그는 실제 엔진 입력과 월드 제재·해제는 교착하지 않는다', async () => {
  const worldId = worlds[1]!,
    actor = await user('ADMIN');
  const human = await db.general.findFirstOrThrow({ where: { worldId, userId: { not: null } } });
  const victim = await db.user.findUniqueOrThrow({ where: { id: human.userId! } });
  const turns = await db.generalTurn.findMany({ where: { worldId, generalId: human.id }, orderBy: { slot: 'asc' } });
  expect(turns).toHaveLength(30);
  for (const kind of ['create', 'lift'] as const) {
    const input = await db.inputEvent.create({
      data: {
        worldId,
        userId: victim.id,
        generalId: human.id,
        kind: 'general.active',
        idempotencyKey: 'sanction-lock:' + randomUUID(),
        payload: {},
        status: 'PENDING',
      },
    });
    const existing =
      kind === 'lift'
        ? await createSanction(
            db,
            actor.id,
            { userId: victim.id, worldId, reason: '동시 해제 준비', expiresAt: null },
            now,
          )
        : null;
    const suffix = randomUUID().replaceAll('-', ''),
      changeName = 't305_world_change_' + suffix;
    const url = new URL(target);
    url.searchParams.set('application_name', changeName);
    const changeDb = createDb(url.href),
      engineDb = createDb(target.href);
    const failures: unknown[] = [],
      pending: Promise<unknown>[] = [];
    let release!: () => void, locked!: () => void, failReady!: (error: unknown) => void, enginePid: number | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve, reject) => {
        locked = resolve;
        failReady = reject;
      });
    void ready.catch(() => undefined);
    const engine = engineDb.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id=${worldId} FOR UPDATE`;
      enginePid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      locked();
      await gate;
      const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
      await processInputs(tx, world, world.clockTick);
    });
    pending.push(engine);
    void engine.catch((error) => failReady(error));
    try {
      await ready;
      const change =
        kind === 'create'
          ? createSanction(
              changeDb,
              actor.id,
              { userId: victim.id, worldId, reason: '동시 생성', expiresAt: null },
              now,
            )
          : liftSanction(changeDb, actor.id, { sanctionId: existing!.sanctionId, reason: '동시 해제' }, now);
      pending.push(change);
      void change.catch(() => undefined);
      await expect
        .poll(async () => {
          const rows = await db.$queryRaw<
            Array<{ blockers: number[] }>
          >`SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=${changeName} AND wait_event_type='Lock' AND state='active'`;
          return rows.some((row) => row.blockers.includes(enginePid!));
        })
        .toBe(true);
      release();
      const results = await Promise.allSettled(pending);
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await db.inputEvent.findUniqueOrThrow({ where: { id: input.id } })).status).toBe('APPLIED');
      expect(
        await db.generalTurn.findMany({ where: { worldId, generalId: human.id }, orderBy: { slot: 'asc' } }),
      ).toEqual(turns);
    } catch (error) {
      failures.push(error);
    } finally {
      release();
      for (const result of await Promise.allSettled(pending))
        if (result.status === 'rejected') failures.push(result.reason);
      for (const result of await Promise.allSettled([engineDb.$disconnect(), changeDb.$disconnect()]))
        if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length) throw new AggregateError([...new Set(failures)], '월드 제재 경합 실행·정리 실패');
  }
});
