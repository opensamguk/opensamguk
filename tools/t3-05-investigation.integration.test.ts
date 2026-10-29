import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { publicMapConfig } from '../packages/shared/src/index';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { appRouter } from '../apps/server/src/router';
import { createRateLimiter } from '../apps/server/src/security/rateLimit';
import type { Context } from '../apps/server/src/context';
import { hashToken } from '../apps/server/src/auth/session';
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
if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('loopback 시험 서버가 필요합니다.');
for (const key of source.searchParams.keys())
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    throw new Error('접속 대상 질의 인자는 쓸 수 없습니다.');
const name = 't305_investigate_' + randomUUID().replaceAll('-', '') + '_test';
const target = new URL(source),
  adminUrl = new URL(source);
target.pathname = '/' + name;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href }),
  gate = new Client({ connectionString: target.href }),
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
        errors.push(new Error('실패한 자기 로그인 DB를 보존합니다.'));
      });
      return track(() => work(controller.signal));
    },
    timeout,
  );
}
beforeEach(settle);
beforeAll(
  () =>
    track(async () => {
      await admin.connect();
      expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows).toHaveLength(0);
      await admin.query(`CREATE DATABASE "${name}"`);
      oid = String(
        (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows[0]!.oid,
      );
      await admin.query(`ALTER DATABASE "${name}" SET statement_timeout='10000'`);
      await gate.connect();
      const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
      for (const migration of (await readdir(migrations)).filter((value) => /^\d{14}_/.test(value)).sort())
        await gate.query(await readFile(new URL(migration + '/migration.sql', migrations), 'utf8'));
      passwordHash = await hashPassword(password);
      sensitive.add(passwordHash);
    }),
  120_000,
);
afterAll(async () => {
  await settle();
  try {
    if (oid) {
      const tables = (await gate.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"))
        .rows;
      for (const { tablename } of tables) {
        if (typeof tablename !== 'string') throw new Error('자기 DB 표 이름을 확인하세요.');
        const quoted = '"' + tablename.replaceAll('"', '""') + '"';
        const rows = await gate.query(
          `SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb)::text AS body FROM ${quoted} t`,
        );
        const body = String(rows.rows[0]!.body);
        if ([...databaseSecrets].some((secret) => body.includes(secret)))
          throw new Error('자기 DB에 원문 비공개 값이 포함됐습니다.');
      }
    }
  } catch (error) {
    errors.push(error);
  }
  const closers: Array<() => Promise<unknown>> = [...apps].map((app) => () => app.close());
  closers.push(
    () => gate.end(),
    () => db.$disconnect(),
  );
  for (const close of closers)
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  const allLogs = logs.join('\n');
  if (allLogs.includes('127.0.0.1') || [...sensitive].some((value) => allLogs.includes(value)))
    errors.push(new Error('전체 종료 로그에 비공개 값이 포함됐습니다.'));
  let connections: number | undefined,
    dropped = false,
    adminClosed = false;
  try {
    if (oid) {
      ({ connections } = await confirmDisconnectedDatabase(admin, name, oid));
      if (!errors.length) {
        await admin.query(`DROP DATABASE "${name}"`);
        dropped = true;
      }
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await admin.end();
    adminClosed = true;
  } catch (error) {
    errors.push(error);
  }
  console.info(
    JSON.stringify({
      event: 'investigation-cleanup',
      name,
      oid,
      connections,
      dropped,
      adminClosed,
      errors: errors.length,
    }),
  );
  if (errors.length) throw new AggregateError([...new Set(errors)], '조사 조회 실행·정리 실패');
}, 120_000);

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

type Group = {
  kind: 'IP' | 'DEVICE';
  label: string;
  users: Array<{ userId: string; generalId: number; generalName: string; logins: number; lastAt: string }>;
};
type User = { id: string; email: string; sid: string; did: string };
const worlds: string[] = [],
  users: User[] = [];
let address: string, actor: User;
async function call(
  path: string,
  input: unknown,
  signal: AbortSignal,
  cookie?: string,
  base = address,
  mutation = false,
) {
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    base + '/trpc/' + path + '?batch=1' + (mutation ? '' : '&input=' + encodeURIComponent(encoded)),
    {
      method: mutation ? 'POST' : 'GET',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const raw = await response.text();
  const body = (
    JSON.parse(raw) as Array<{
      result?: { data: unknown };
      error?: { message: string; data: { code: string; reason: string | null } };
    }>
  )[0]!;
  const cookies = response.headers.getSetCookie();
  for (const value of cookies) {
    const token = value.split(';')[0]?.split('=')[1];
    if (token) {
      sensitive.add(token);
      databaseSecrets.add(token);
    }
  }
  return {
    status: response.status,
    raw,
    data: body.result?.data,
    code: body.error?.data.code,
    reason: body.error?.data.reason,
    sid: cookies.find((value) => value.startsWith('sid='))?.split(';')[0],
    did: cookies.find((value) => value.startsWith('did='))?.split(';')[0],
  };
}
async function signup(signal: AbortSignal, did?: string) {
  const email = randomUUID() + '@example.test';
  sensitive.add(email);
  const response = await call('auth.signup', { email, password }, signal, did, address, true);
  expect(response.status).toBe(200);
  expect(typeof response.sid === 'string' && typeof response.did === 'string', '가입 쿠키가 필요합니다.').toBe(true);
  const id = (response.data as { user: { id: string } }).user.id;
  return { id, email, sid: response.sid!, did: response.did! };
}
async function footprint(excludeAudit = false) {
  const hash = createHash('sha256');
  const tables = (await gate.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"))
    .rows;
  for (const { tablename } of tables) {
    if (typeof tablename !== 'string') throw new Error('자기 표 이름을 확인하세요.');
    if (excludeAudit && tablename === 'AuditLog') continue;
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const rows = await gate.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t`,
    );
    hash.update(tablename + ':' + String(rows.rows[0]!.body) + '\n');
  }
  return hash.digest('hex');
}
async function audits() {
  return db.auditLog.findMany({
    where: { action: 'investigate.shared.view' },
    orderBy: { id: 'asc' },
    select: { actorUserId: true, worldId: true, payload: true },
  });
}

it('AC-M3-05 정식 두 월드와 실제 같은 기기 가입·장수 생성으로 조사 선행을 준비한다', async (signal) => {
  ({ address } = await start());
  const first = await signup(signal),
    second = await signup(signal, first.did),
    other = await signup(signal);
  users.push(first, second, other);
  actor = await signup(signal);
  // 관리자 역할만 통제하는 계정 고정물이다. 원문 로그인 기록·장수는 실제 API로 만든다.
  await db.user.update({ where: { id: actor.id }, data: { role: 'ADMIN' } });
  for (const index of [0, 1]) {
    signal.throwIfAborted();
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'investigation-world-' + index,
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
    expect(initial.cities).toHaveLength(61);
    const { worldId } = await saveInitialWorld(db, initial, {
      name: '조사 격리 월드 ' + index,
      turnTermMinutes: 60,
      endYear: 201,
    });
    worlds.push(worldId);
    await controlClock(db, worldId, 'start');
    for (const user of index === 0 ? [first, second] : [other]) {
      const request = call(
        'general.create',
        {
          worldId,
          name: '조사사람' + users.indexOf(user),
          portraitId: null,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
        },
        signal,
        user.sid,
        address,
        true,
      );
      const settling = Promise.allSettled([request]);
      const failures: unknown[] = [];
      try {
        await expect
          .poll(() => db.inputEvent.count({ where: { worldId, userId: user.id, status: 'PENDING' } }), {
            timeout: 10_000,
          })
          .toBe(1);
        const lease = await acquireLease(db, worldId);
        if (!lease) throw new Error('자기 월드 리스가 필요합니다.');
        try {
          await new TurnLoop(db, lease).advanceTo(0);
        } catch (error) {
          failures.push(error);
        } finally {
          try {
            await releaseLease(db, lease);
          } catch (error) {
            failures.push(error);
          }
        }
      } catch (error) {
        failures.push(error);
      }
      const results = await settling;
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, '실제 사람 생성·리스 정리 실패');
      expect((await request).status).toBe(200);
      const general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: user.id } } });
      expect(await db.generalTurn.count({ where: { worldId, generalId: general.id } })).toBe(30);
    }
    expect(await db.nation.count({ where: { worldId } })).toBe(21);
    expect(await db.general.count({ where: { worldId, userId: null } })).toBe(491);
  }
}, 120_000);

it('AC-M3-05 선택한 월드의 IP·기기 묶음과 횟수·시각을 반환하고 감사만 1회 쓴다', async (signal) => {
  const before = await footprint(true),
    beforeAudit = (await audits()).length;
  const response = await call('admin.investigate.shared', { worldId: worlds[0] }, signal, actor.sid);
  expect(response.status).toBe(200);
  const groups = response.data as Group[];
  expect(groups.map((group) => group.kind)).toEqual(['IP', 'DEVICE']);
  const expectedIp = createHmac('sha256', key).update('127.0.0.1').digest('hex').slice(0, 8);
  const expectedDevice = createHmac('sha256', key).update(users[0]!.did.slice(4)).digest('hex').slice(0, 8);
  expect(groups.map((group) => group.label)).toEqual([expectedIp, expectedDevice]);
  for (const group of groups) {
    expect(group.users.map((user) => user.userId).sort()).toEqual(
      users
        .slice(0, 2)
        .map((user) => user.id)
        .sort(),
    );
    for (const user of group.users) {
      const general = await db.general.findUniqueOrThrow({
        where: { worldId_userId: { worldId: worlds[0]!, userId: user.userId } },
      });
      const observed = await db.$queryRaw<
        Array<{ n: bigint; last: Date }>
      >`SELECT count(*) AS n,max(at) AS last FROM "LoginRecord" WHERE "userId"=${user.userId} AND "hashKeyVersion"=1`;
      expect(user).toEqual({
        userId: user.userId,
        generalId: general.id,
        generalName: general.name,
        logins: Number(observed[0]!.n),
        lastAt: observed[0]!.last.toISOString(),
      });
    }
  }
  expect(await footprint(true)).toBe(before);
  expect((await audits()).slice(beforeAudit)).toEqual([
    { actorUserId: actor.id, worldId: worlds[0], payload: { days: 7, groupCount: 2 } },
  ]);
  for (const secret of sensitive) expect(response.raw.includes(secret), '조회 원문 비공개 값 없음').toBe(false);
  expect(response.raw.includes('127.0.0.1'), '조회 IP 원문 없음').toBe(false);
  expect(/\b[0-9a-f]{64}\b/.test(response.raw), '전체 해시 없음').toBe(false);
});

it('AC-M3-05 다른 월드의 단일 참가자는 묶음이 없고 빈 조회도 감사 1회를 남긴다', async (signal) => {
  const before = await footprint(true),
    count = (await audits()).length;
  const response = await call('admin.investigate.shared', { worldId: worlds[1], days: 90 }, signal, actor.sid);
  expect(response.status).toBe(200);
  expect(response.data).toEqual([]);
  expect(await footprint(true)).toBe(before);
  expect((await audits()).slice(count)).toEqual([
    { actorUserId: actor.id, worldId: worlds[1], payload: { days: 90, groupCount: 0 } },
  ]);
});

it('AC-M3-05 실제 실패 횟수는 포함하고 오래된·미래·다른 버전 기록은 섞지 않는다', async (signal) => {
  const first = users[0]!,
    login = { email: first.email, password };
  const before = await call('admin.investigate.shared', { worldId: worlds[0] }, signal, actor.sid);
  const wrong = await call('auth.login', { ...login, password: password + '!' }, signal, first.did, address, true);
  expect(wrong.status).toBe(401);
  const counted = await call('admin.investigate.shared', { worldId: worlds[0] }, signal, actor.sid);
  expect(counted.status).toBe(200);
  for (const group of counted.data as Group[]) {
    const prior = (before.data as Group[])
      .find((value) => value.kind === group.kind)!
      .users.find((user) => user.userId === first.id)!;
    expect(group.users.find((user) => user.userId === first.id)!.logins).toBe(prior.logins + 1);
  }
  for (const offset of [-91 * 86_400_000, 86_400_000]) {
    // 서버 시계만 주입한 실제 로그인이다. LoginRecord 행을 SQL로 만들지 않는다.
    const clocked = await start({ now: () => Date.now() + offset });
    expect((await call('auth.login', login, signal, first.did, clocked.address, true)).status).toBe(200);
  }
  // 버전이 다르면 전체 해시가 같아도 합치지 않는 반례다. 실제 수집을 통한다.
  const versioned = await start({ loginAudit: { key, version: 2 } });
  expect((await call('auth.login', login, signal, first.did, versioned.address, true)).status).toBe(200);
  const beforeRead = await footprint(true);
  const isolated = await call('admin.investigate.shared', { worldId: worlds[0] }, signal, actor.sid);
  expect(isolated.status).toBe(200);
  expect(JSON.stringify(isolated.data) === JSON.stringify(counted.data), '기간·버전 밖 기록 제외').toBe(true);
  expect(await footprint(true)).toBe(beforeRead);
});

for (const category of categories)
  it(
    'admin.investigate.shared ' + category,
    authzCase('admin.investigate.shared', category, async () => {
      const signal = AbortSignal.timeout(20_000);
      const session = newSession(Date.now());
      sensitive.add(session.token);
      databaseSecrets.add(session.token);
      const user = await db.user.create({
        data: {
          email: randomUUID() + '@example.test',
          passwordHash,
          role: category === 'otherUser' ? 'USER' : 'ADMIN',
          status: category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE',
        },
      });
      sensitive.add(user.email);
      await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
      const before = await footprint(category === 'success'),
        count = (await audits()).length;
      const response = await call(
        'admin.investigate.shared',
        category === 'invalidInput' ? { worldId: worlds[0], days: 91, userId: user.id } : { worldId: worlds[0] },
        signal,
        category === 'unauthenticated' ? undefined : 'sid=' + session.token,
      );
      if (category === 'success') {
        expect(response.status).toBe(200);
        expect(response.data as Group[]).toHaveLength(2);
        expect((await audits()).length).toBe(count + 1);
      } else {
        expect(response.code).toBe(
          category === 'otherUser' ? 'FORBIDDEN' : category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED',
        );
        expect(response.data).toBeUndefined();
        expect((await audits()).length).toBe(count);
      }
      expect(await footprint(category === 'success')).toBe(before);
    }),
  );

it('AC-M3-05 감사 INSERT 실패에는 자료와 감사가 모두 없고 게임·계정 상태도 보존된다', async (signal) => {
  const before = await footprint();
  await gate.query(`CREATE FUNCTION investigate_audit_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='investigate.shared.view' THEN RAISE EXCEPTION 'investigation audit rejected'; END IF; RETURN NEW; END $$`);
  await gate.query(
    `CREATE TRIGGER investigate_audit_block BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION investigate_audit_block()`,
  );
  const failures: unknown[] = [];
  try {
    const response = await call('admin.investigate.shared', { worldId: worlds[0] }, signal, actor.sid);
    expect(response.status).toBe(500);
    expect(response.code).toBe('INTERNAL_SERVER_ERROR');
    expect(response.data).toBeUndefined();
    expect(response.raw.includes('investigation audit rejected'), '감사 오류 원문 없음').toBe(false);
    expect(/\b[0-9a-f]{8,64}\b/.test(response.raw), '감사 실패에 조사 자료 없음').toBe(false);
    expect(await footprint()).toBe(before);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await gate.query('DROP TRIGGER investigate_audit_block ON "AuditLog"');
    } catch (error) {
      failures.push(error);
    }
    try {
      await gate.query('DROP FUNCTION investigate_audit_block()');
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '조사 감사 원자성·trigger 정리 실패');
});

it('AC-M3-05 Context 생성 뒤 권한·세션이 바뀌어도 실제 조회가 다시 검사한다', async () => {
  const signal = AbortSignal.timeout(20_000);
  for (const mode of [
    'role',
    'logout',
    'expiry',
    'withdrawn',
    'sanction',
    'unverified',
    'consent',
    'policy',
  ] as const) {
    const session = newSession(Date.now()),
      email = randomUUID() + '@example.test';
    sensitive.add(session.token);
    sensitive.add(email);
    databaseSecrets.add(session.token);
    const user = await db.user.create({ data: { email, passwordHash, role: 'ADMIN' } });
    await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
    const identity: Context = {
      db,
      publicMapConfig: publicMapConfig({}),
      user: { id: user.id, email },
      sessionId: hashToken(session.token),
      now: Date.now(),
      ip: '127.0.0.1',
      dummyPasswordHash: passwordHash,
      secureCookies: false,
      emailVerificationRequired: mode === 'unverified',
      legalPolicy:
        mode === 'consent'
          ? {
              terms: {
                version: 'investigation-test-terms',
                effectiveAt: '2026-01-01T00:00:00Z',
                bodyText: '검사 전용 약관',
              },
              privacy: {
                version: 'investigation-test-privacy',
                effectiveAt: '2026-01-01T00:00:00Z',
                bodyText: '검사 전용 정책',
              },
            }
          : null,
      legalPolicyRequired: mode === 'policy',
      withdrawalPolicy: null,
      rateLimiter: createRateLimiter({ now: Date.now }),
      reply: { header() {}, setCookie() {}, clearCookie() {}, log: { warn() {} } } as unknown as Context['reply'],
    };
    const caller = appRouter.createCaller(identity);
    if (mode === 'role') await db.user.update({ where: { id: user.id }, data: { role: 'USER' } });
    if (mode === 'logout') await db.session.delete({ where: { id: session.id } });
    if (mode === 'expiry') await db.session.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } });
    if (mode === 'withdrawn') await db.user.update({ where: { id: user.id }, data: { status: 'WITHDRAWN' } });
    if (mode === 'sanction')
      await db.sanction.create({ data: { userId: user.id, createdBy: user.id, reason: '현재 권한 거부 고정물' } });
    signal.throwIfAborted();
    const before = await footprint();
    const expected =
      mode === 'policy'
        ? 'SERVICE_UNAVAILABLE'
        : ['role', 'unverified', 'consent'].includes(mode)
          ? 'FORBIDDEN'
          : 'UNAUTHORIZED';
    await expect(caller.admin.investigate.shared({ worldId: worlds[0]! })).rejects.toMatchObject({ code: expected });
    await expect(caller.admin.user.get({ userId: users[0]!.id })).rejects.toMatchObject({ code: expected });
    expect(await footprint()).toBe(before);
  }
});

it('AC-M3-05 사용자 상세의 최근90일 기록 4필드와 기존 상세·감사 계약을 보존한다', async (signal) => {
  const targetUser = users[0]!;
  const before = await footprint(true);
  const response = await call('admin.user.get', { userId: targetUser.id }, signal, actor.sid);
  expect(response.status).toBe(200);
  const detail = response.data as {
    userId: string;
    email: string;
    status: string;
    role: string;
    createdAt: string;
    emailVerified: boolean;
    generalCount: number;
    sanctionCount: number;
    generals: Array<{
      generalId: number;
      name: string;
      nationId: number | null;
      worldId: string;
      worldName: string;
      worldStatus: string;
    }>;
    sanctions: unknown[];
    recentLogins: Array<{ at: string; success: boolean; ipLabel: string; deviceLabel: string | null }>;
  };
  expect(Object.keys(detail).sort()).toEqual(
    [
      'userId',
      'email',
      'status',
      'role',
      'createdAt',
      'emailVerified',
      'generalCount',
      'sanctionCount',
      'generals',
      'sanctions',
      'recentLogins',
    ].sort(),
  );
  const user = await db.user.findUniqueOrThrow({ where: { id: targetUser.id } });
  expect(detail.email === user.email && detail.userId === user.id, '기존 상세 계정').toBe(true);
  expect({
    status: detail.status,
    role: detail.role,
    emailVerified: detail.emailVerified,
    generalCount: detail.generalCount,
    sanctionCount: detail.sanctionCount,
    sanctions: detail.sanctions,
  }).toEqual({
    status: 'ACTIVE',
    role: 'USER',
    emailVerified: false,
    generalCount: 1,
    sanctionCount: 0,
    sanctions: [],
  });
  expect(detail.createdAt).toBe(user.createdAt.toISOString());
  const general = await db.general.findUniqueOrThrow({
    where: { worldId_userId: { worldId: worlds[0]!, userId: targetUser.id } },
    include: { world: { select: { name: true, status: true } } },
  });
  expect(detail.generals).toEqual([
    {
      generalId: general.id,
      name: general.name,
      nationId: general.nationId,
      worldId: general.worldId,
      worldName: general.world.name,
      worldStatus: general.world.status,
    },
  ]);
  const rows = await db.$queryRaw<Array<{ at: Date; success: boolean; ipLabel: string; deviceLabel: string | null }>>`
    SELECT at,success,left("ipHash",8) AS "ipLabel",left("deviceHash",8) AS "deviceLabel" FROM "LoginRecord"
    WHERE "userId"=${targetUser.id} AND at>=clock_timestamp()-interval '90 days' AND at<=clock_timestamp()
    ORDER BY at DESC,id DESC LIMIT 50`;
  expect(
    JSON.stringify(detail.recentLogins) === JSON.stringify(rows.map((row) => ({ ...row, at: row.at.toISOString() }))),
    '정확한 최근 기록 4필드',
  ).toBe(true);
  expect(detail.recentLogins.some((record) => !record.success)).toBe(true);
  expect(await footprint(true)).toBe(before);
  const audit = await db.auditLog.findFirstOrThrow({
    where: { action: 'user.view', targetId: targetUser.id },
    orderBy: { id: 'desc' },
    select: { actorUserId: true, payload: true },
  });
  expect(audit).toEqual({
    actorUserId: actor.id,
    payload: { resultCount: 1, generalsDisplayed: 1, sanctionsDisplayed: 0 },
  });
  for (const secret of databaseSecrets) expect(response.raw.includes(secret), '상세 원문 비공개 값 없음').toBe(false);
  expect(/\b[0-9a-f]{64}\b/.test(response.raw), '상세 전체 해시 없음').toBe(false);
});

it('AC-M3-05 사용자 최근 기록도 감사 실패에는 응답하지 않는다', async (signal) => {
  const before = await footprint();
  await gate.query(`CREATE FUNCTION recent_login_audit_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='user.view' THEN RAISE EXCEPTION 'recent login audit rejected'; END IF; RETURN NEW; END $$`);
  await gate.query(
    `CREATE TRIGGER recent_login_audit_block BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION recent_login_audit_block()`,
  );
  const failures: unknown[] = [];
  try {
    const response = await call('admin.user.get', { userId: users[0]!.id }, signal, actor.sid);
    expect(response.status).toBe(500);
    expect(response.code).toBe('INTERNAL_SERVER_ERROR');
    expect(response.data).toBeUndefined();
    expect(response.raw.includes('recent login audit rejected'), '상세 감사 오류 원문 없음').toBe(false);
    for (const secret of databaseSecrets) expect(response.raw.includes(secret), '감사 거부 원문 없음').toBe(false);
    expect(await footprint()).toBe(before);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await gate.query('DROP TRIGGER recent_login_audit_block ON "AuditLog"');
    } catch (error) {
      failures.push(error);
    }
    try {
      await gate.query('DROP FUNCTION recent_login_audit_block()');
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '최근 기록 감사·trigger 정리 실패');
});

it('AC-M3-05 실제 로그인 51건의 같은 시각 기록도 id 역순 최대50건만 반환한다', async (signal) => {
  const targetUser = users[0]!,
    at = Date.now();
  let base = '';
  for (let index = 0; index < 51; index++) {
    signal.throwIfAborted();
    // 새 실제 서버로 한도 계수만 초기화한다. 기록·비밀번호·키·기간 검사는 그대로다.
    if (index % 8 === 0) base = (await start({ now: () => at })).address;
    const success = index % 2 === 0;
    const response = await call(
      'auth.login',
      { email: targetUser.email, password: success ? password : password + '!' },
      signal,
      targetUser.did,
      base,
      true,
    );
    expect(response.status).toBe(success ? 200 : 401);
  }
  const before = await footprint(true);
  const response = await call('admin.user.get', { userId: targetUser.id }, signal, actor.sid);
  expect(response.status).toBe(200);
  const actual = (
    response.data as {
      recentLogins: Array<{ at: string; success: boolean; ipLabel: string; deviceLabel: string | null }>;
    }
  ).recentLogins;
  expect(actual).toHaveLength(50);
  expect(
    actual.every((record) => record.at === new Date(at).toISOString()),
    '같은 시각 50건',
  ).toBe(true);
  expect(actual.map((record) => record.success)).toEqual(Array.from({ length: 50 }, (_, index) => index % 2 === 0));
  expect(await footprint(true)).toBe(before);
}, 120_000);
