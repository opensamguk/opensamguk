import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { testDatabaseUrl } from './test-database';
import { initializeResources } from './init-resources';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import type { LegalPolicy } from '../apps/server/src/legal/policy';
import { appRouter } from '../apps/server/src/router';
import type { ProcedureMeta } from '../apps/server/src/trpc';
import { TurnLoop } from '../apps/engine/src/turnLoop';

type Pg = {
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
const name = `t302_consent_${randomUUID().replaceAll('-', '')}_test`;
const adminUrl = new URL(source),
  target = new URL(source);
adminUrl.pathname = '/postgres';
target.pathname = '/' + name;
const admin = new Client({ connectionString: adminUrl.href }),
  client = new Client({ connectionString: target.href });
const db = createDb(target.href),
  now = Date.now(),
  origin = 'http://127.0.0.1:5173';
const policy: LegalPolicy = {
  terms: { version: 'test-terms-1', effectiveAt: '2026-10-01T00:00:00Z' },
  privacy: { version: 'test-privacy-1', effectiveAt: '2026-10-01T00:00:00Z' },
};
const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];
const password = randomUUID();
const delivered: Array<{ consentRows: number; tokenRows: number; sessionRows: number }> = [];
const executions = new Set<Promise<unknown>>(),
  errors: unknown[] = [],
  logs: string[] = [],
  sensitive = new Set<string>();
let app: Awaited<ReturnType<typeof buildServer>> | undefined,
  address: string,
  created = false,
  oid: unknown;
let beforeCatalog: Record<string, unknown>[] = [],
  passwordHash: string;
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
  email = `${randomUUID()}@example.test`,
) {
  sensitive.add(email);
  return db.user.create({
    data: { email, passwordHash, role, status, emailVerifiedAt: verified ? new Date(now) : null },
  });
}
async function session(userId: string) {
  const value = newSession(now);
  sensitive.add(value.token);
  await db.session.create({ data: { id: value.id, userId, expiresAt: value.expiresAt } });
  return `sid=${value.token}`;
}
function call(path: string, input: unknown, cookie?: string, base = address, requestOrigin = origin) {
  return track(async () => {
    const procedure = (appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>)[path];
    if (!procedure) throw new Error('검사 절차를 확인하세요.');
    const mutation = procedure._def.type === 'mutation',
      encoded = JSON.stringify({ 0: input });
    const response = await fetch(
      base + '/trpc/' + path + '?batch=1' + (mutation ? '' : '&input=' + encodeURIComponent(encoded)),
      {
        method: mutation ? 'POST' : 'GET',
        headers: {
          origin: requestOrigin,
          ...(cookie ? { cookie } : {}),
          ...(mutation ? { 'content-type': 'application/json' } : {}),
        },
        ...(mutation ? { body: encoded } : {}),
        signal: AbortSignal.timeout(10000),
      },
    );
    const raw = await response.text();
    const [body] = JSON.parse(raw) as Array<{
      result?: { data: unknown };
      error?: { data: { code: string; reason: string | null } };
    }>;
    return {
      status: response.status,
      data: body!.result?.data,
      code: body!.error?.data.code,
      reason: body!.error?.data.reason,
      raw,
      cookie: response.headers
        .getSetCookie()
        .find((value) => value.startsWith('sid='))
        ?.split(';')[0],
    };
  });
}
async function gameSnapshot(account = false) {
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const hash = createHash('sha256');
  for (const { tablename } of tables) {
    if (!account && ['AuditLog', 'User', 'Session', 'Sanction', 'ConsentRecord', 'AccountToken'].includes(tablename))
      continue;
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const rows = await db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t`,
    );
    hash.update(tablename + '\n' + rows[0]!.body + '\n');
  }
  return hash.digest('hex');
}
beforeAll(() =>
  track(async () => {
    await admin.connect();
    beforeCatalog = await catalog();
    expect(beforeCatalog.some((row) => row.datname === name)).toBe(false);
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    oid = (await catalog()).find((row) => row.datname === name)?.oid;
    expect(typeof oid).toBe('string');
    await client.connect();
    const root = new URL('../packages/db/prisma/migrations/', import.meta.url);
    for (const migration of (await readdir(root)).filter((value) => /^\d{14}_/.test(value)).sort())
      await client.query(await readFile(new URL(migration + '/migration.sql', root), 'utf8'));
    await initializeResources(
      db,
      await readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
    );
    passwordHash = await hashPassword(password);
    sensitive.add(password);
    sensitive.add(passwordHash);
    app = await buildServer({
      db,
      now: () => now,
      publicOrigin: origin,
      emailVerificationRequired: true,
      legalPolicy: policy,
      mailTransport: {
        async send(message) {
          const actor = await db.user.findUniqueOrThrow({ where: { email: message.to }, select: { id: true } });
          delivered.push({
            consentRows: await db.consentRecord.count({ where: { userId: actor.id } }),
            tokenRows: await db.accountToken.count({ where: { userId: actor.id } }),
            sessionRows: await db.session.count({ where: { userId: actor.id } }),
          });
        },
      },
      logStream: {
        write(chunk: string) {
          logs.push(chunk);
        },
      },
    });
    servers.push(app);
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  }),
);
afterAll(async () => {
  await settle();
  for (const close of [...servers.map((server) => () => server.close()), () => client.end(), () => db.$disconnect()]) {
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
    JSON.stringify({ event: 't302-consent-cleanup', name, oid, connections, dropped, errors: errors.length }),
  );
  if (errors.length) throw new AggregateError([...new Set(errors)], '동의 실행·정리 실패');
});

for (const path of ['legal.current', 'legal.agree'])
  for (const category of categories) {
    if (path === 'legal.current' && category === 'otherUser') continue;
    it(
      `${path} ${category}`,
      authzCase(path, category, async () => {
        const actor = await user('USER', category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE');
        const other = await user();
        const cookie = category === 'unauthenticated' ? undefined : await session(actor.id);
        const input =
          path === 'legal.current'
            ? category === 'invalidInput'
              ? { userId: other.id }
              : undefined
            : category === 'invalidInput'
              ? { docType: 'TERMS', version: policy.terms.version, role: 'ADMIN' }
              : {
                  docType: 'TERMS',
                  version: policy.terms.version,
                  ...(category === 'otherUser' ? { userId: other.id } : {}),
                };
        const before = await gameSnapshot();
        const result = await call(path, input, cookie);
        const expected =
          category === 'invalidInput' || (path === 'legal.agree' && category === 'otherUser')
            ? 400
            : path === 'legal.agree' && ['unauthenticated', 'sanctioned'].includes(category)
              ? 401
              : 200;
        expect(result.status).toBe(expected);
        if (path === 'legal.current' && expected === 200) expect(result.data).toEqual({ status: 'current', ...policy });
        expect(await db.consentRecord.count({ where: { userId: actor.id } })).toBe(
          path === 'legal.agree' && expected === 200 ? 1 : 0,
        );
        expect(await db.consentRecord.count({ where: { userId: other.id } })).toBe(0);
        for (const secret of sensitive) expect(result.raw.includes(secret), '약관 응답 비밀값 비노출').toBe(false);
        expect(await gameSnapshot()).toBe(before);
      }),
    );
  }

async function serverFor(options: { policy: LegalPolicy | null; production?: boolean; at?: number }) {
  const requestOrigin = options.production ? 'https://local.example.invalid' : origin;
  const server = await buildServer({
    db,
    logging: false,
    now: () => options.at ?? now,
    publicOrigin: requestOrigin,
    emailVerificationRequired: true,
    legalPolicy: options.policy,
    ...(options.production ? { production: true } : {}),
  });
  servers.push(server);
  return { address: await server.listen({ host: '127.0.0.1', port: 0 }), origin: requestOrigin };
}

it('승인 전에는 운영 가입·변경·동의를 막고 개발 계정·동의 기록은 보존한다', async () => {
  for (const production of [false, true]) {
    const actor = await user(),
      cookie = await session(actor.id);
    const server = await serverFor({ policy: null, production });
    const request = (path: string, input: unknown) => call(path, input, cookie, server.address, server.origin);
    expect((await request('legal.current', undefined)).data).toEqual({ status: 'pending', terms: null, privacy: null });
    expect((await request('legal.agree', { docType: 'TERMS', version: policy.terms.version })).status).toBe(503);
    expect((await request('account.get', undefined)).data).toMatchObject({
      legalPolicyApproved: false,
      consentRequired: [],
      consents: [],
    });
    const before = await gameSnapshot(true);
    expect((await request('general.create', {})).status).toBe(production ? 503 : 400);
    expect(
      (
        await request('auth.signup', {
          email: `${randomUUID()}@example.test`,
          password,
          consents: { terms: 'fake', privacy: 'fake' },
        })
      ).status,
    ).toBe(production ? 503 : 400);
    if (production) {
      expect((await request('auth.signup', { email: `${randomUUID()}@example.test`, password })).status).toBe(503);
      expect(await gameSnapshot(true)).toBe(before);
    } else {
      expect(await gameSnapshot(true)).toBe(before);
      const result = await request('auth.signup', { email: `${randomUUID()}@example.test`, password });
      expect(result.status).toBe(200);
      const id = (result.data as { user: { id: string } }).user.id;
      expect(await db.consentRecord.count({ where: { userId: id } })).toBe(0);
    }
  }
});

it('가입은 현재 두 판의 명시 동의를 같은 트랜잭션에 기록하며 누락·구판·위조를 거부한다', async () => {
  const email = `${randomUUID()}@example.test`;
  sensitive.add(email);
  const before = await gameSnapshot(true);
  for (const consents of [
    undefined,
    { terms: policy.terms.version },
    { privacy: policy.privacy.version },
    { terms: 'old', privacy: policy.privacy.version },
    { terms: policy.terms.version, privacy: 'old' },
    { terms: policy.terms.version, privacy: policy.privacy.version, approved: true },
  ]) {
    expect((await call('auth.signup', { email, password, ...(consents ? { consents } : {}) })).status).toBe(400);
    expect(await gameSnapshot(true)).toBe(before);
  }
  const result = await call('auth.signup', {
    email,
    password,
    consents: { terms: policy.terms.version, privacy: policy.privacy.version },
  });
  expect(result.status).toBe(200);
  const actor = (result.data as { user: { id: string; emailVerified: boolean } }).user;
  expect(actor.emailVerified).toBe(false);
  expect(result.cookie?.startsWith('sid=')).toBe(true);
  expect(await db.session.count({ where: { userId: actor.id } })).toBe(1);
  expect(await db.accountToken.count({ where: { userId: actor.id } })).toBe(1);
  expect(delivered.at(-1)).toEqual({ consentRows: 2, tokenRows: 1, sessionRows: 1 });
  expect(
    await db.consentRecord.findMany({
      where: { userId: actor.id },
      select: { docType: true, version: true, agreedAt: true },
      orderBy: { docType: 'asc' },
    }),
  ).toEqual([
    { docType: 'TERMS', version: policy.terms.version, agreedAt: new Date(now) },
    { docType: 'PRIVACY', version: policy.privacy.version, agreedAt: new Date(now) },
  ]);
});

it('동의 INSERT 실패는 계정·세션·토큰·다른 동의까지 롤백하고 원문 오류를 숨긴다', async () => {
  const email = `${randomUUID()}@example.test`;
  sensitive.add(email);
  const before = await gameSnapshot(true);
  const beforeMail = delivered.length;
  await client.query(
    `CREATE FUNCTION t302_fail_consent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-consent-failure'; END $$`,
  );
  await client.query(
    `CREATE TRIGGER t302_fail_consent BEFORE INSERT ON "ConsentRecord" FOR EACH ROW WHEN (NEW."docType"='PRIVACY') EXECUTE FUNCTION t302_fail_consent()`,
  );
  try {
    const result = await call('auth.signup', {
      email,
      password,
      consents: { terms: policy.terms.version, privacy: policy.privacy.version },
    });
    expect(result.status).toBe(500);
    expect(result.cookie).toBeUndefined();
    expect(delivered).toHaveLength(beforeMail);
    for (const value of [...sensitive, 'private-consent-failure'])
      expect(result.raw.includes(value), '가입 오류 비밀값 비노출').toBe(false);
    expect(await gameSnapshot(true)).toBe(before);
  } finally {
    await client.query('DROP TRIGGER t302_fail_consent ON "ConsentRecord"');
    await client.query('DROP FUNCTION t302_fail_consent()');
  }
});

it('인증 전 동의·중복 동의·판 변경은 문서별 최초 동의 시각과 옛 기록을 보존한다', async () => {
  const actor = await user('USER', 'ACTIVE', false),
    cookie = await session(actor.id);
  const agree = (docType: 'TERMS' | 'PRIVACY') =>
    call('legal.agree', { docType, version: policy[docType === 'TERMS' ? 'terms' : 'privacy'].version }, cookie);
  expect((await call('general.create', {}, cookie)).reason).toBe('EMAIL_NOT_VERIFIED');
  expect((await call('account.get', undefined, cookie)).data).toMatchObject({ consentRequired: ['TERMS', 'PRIVACY'] });
  const duplicate = await Promise.allSettled([agree('TERMS'), agree('TERMS')]);
  const rejected = duplicate.filter((result) => result.status === 'rejected');
  if (rejected.length)
    throw new AggregateError(
      rejected.map((result) => result.reason),
      '동시 동의 요청 실패',
    );
  expect(duplicate.map((result) => (result.status === 'fulfilled' ? result.value.status : null))).toEqual([200, 200]);
  expect(await db.consentRecord.count({ where: { userId: actor.id, docType: 'TERMS' } })).toBe(1);
  expect((await call('account.get', undefined, cookie)).data).toMatchObject({ consentRequired: ['PRIVACY'] });
  expect((await agree('PRIVACY')).status).toBe(200);
  await db.user.update({ where: { id: actor.id }, data: { emailVerifiedAt: new Date(now) } });
  expect((await call('general.create', {}, cookie)).status).toBe(400);
  const changed: LegalPolicy = { ...policy, terms: { ...policy.terms, version: 'test-terms-2' } };
  const server = await serverFor({ policy: changed, at: now + 1000 });
  const request = (path: string, input: unknown) => call(path, input, cookie, server.address);
  expect((await request('auth.me', undefined)).data).toMatchObject({
    user: { id: actor.id, emailVerified: true, consentRequired: ['TERMS'] },
  });
  expect((await request('general.create', {})).reason).toBe('CONSENT_REQUIRED');
  expect((await request('legal.agree', { docType: 'TERMS', version: policy.terms.version })).status).toBe(400);
  expect((await request('legal.agree', { docType: 'TERMS', version: changed.terms.version })).status).toBe(200);
  expect((await request('legal.agree', { docType: 'PRIVACY', version: policy.privacy.version })).status).toBe(200);
  expect(
    await db.consentRecord.findMany({
      where: { userId: actor.id },
      select: { docType: true, version: true, agreedAt: true },
      orderBy: [{ docType: 'asc' }, { version: 'asc' }],
    }),
  ).toEqual([
    { docType: 'TERMS', version: policy.terms.version, agreedAt: new Date(now) },
    { docType: 'TERMS', version: changed.terms.version, agreedAt: new Date(now + 1000) },
    { docType: 'PRIVACY', version: policy.privacy.version, agreedAt: new Date(now) },
  ]);
});

const formalWorlds: string[] = [];
it('계정 비활성화가 먼저 잠그면 대기 중 실제 동의 요청은 기록을 만들지 않는다', async () => {
  const actor = await user(),
    cookie = await session(actor.id),
    before = await gameSnapshot();
  const blocker = new Client({ connectionString: target.href });
  let pending: ReturnType<typeof call> | undefined;
  let bodyError: unknown;
  try {
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [actor.id]);
    await blocker.query('UPDATE "User" SET status=\'WITHDRAWN\' WHERE id=$1', [actor.id]);
    pending = call('legal.agree', { docType: 'TERMS', version: policy.terms.version }, cookie);
    await expect
      .poll(async () =>
        Number(
          (
            await client.query(
              `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'`,
              [name],
            )
          ).rows[0]!.count,
        ),
      )
      .toBe(1);
    await blocker.query('COMMIT');
    expect((await pending).status).toBe(401);
    expect(await db.consentRecord.count({ where: { userId: actor.id } })).toBe(0);
    expect(await gameSnapshot()).toBe(before);
  } catch (error) {
    bodyError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await blocker.query('ROLLBACK');
  } catch (error) {
    cleanupErrors.push(error);
  }
  const settled = await Promise.allSettled([
    Promise.resolve().then(() => blocker.end()),
    Promise.resolve().then(() => pending),
  ]);
  for (const result of settled) if (result.status === 'rejected') cleanupErrors.push(result.reason);
  if (bodyError || cleanupErrors.length)
    throw new AggregateError([...(bodyError ? [bodyError] : []), ...cleanupErrors], '동의 잠금 경합 실행·정리 실패');
});

for (let index = 0; index < 2; index++)
  it(`정식191년 ${index + 1}번째 월드를 실제8개 규칙으로 준비한다`, async () => {
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'consent-191-' + index,
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
    expect(initial.generals).toHaveLength(491);
    expect(initial.nations).toHaveLength(21);
    const saved = await saveInitialWorld(db, initial, {
      name: '동의 경계 정식191 ' + index,
      turnTermMinutes: 60,
      endYear: 201,
    });
    formalWorlds.push(saved.worldId);
    await controlClock(db, saved.worldId, 'start');
  });

it('두 정식 월드의 미동의 변경은 전부403·무변경이며 실제 동의 뒤 생성·30칸 예약이 성공한다', async () => {
  expect(formalWorlds).toHaveLength(2);
  const actor = await user(),
    cookie = await session(actor.id);
  const procedures = appRouter._def.procedures as unknown as Record<
    string,
    { _def: { type: string; meta?: ProcedureMeta } }
  >;
  const paths = Object.entries(procedures)
    .filter(([, procedure]) => procedure._def.type === 'mutation' && procedure._def.meta?.accountAccess === 'verified')
    .map(([path]) => path);
  expect(paths).toHaveLength(25);
  const before = await gameSnapshot(true);
  for (const worldId of formalWorlds)
    for (const path of paths) {
      const result = await call(path, { worldId, userId: actor.id, consentRequired: [] }, cookie);
      expect(result.status, path).toBe(403);
      expect(result.reason, path).toBe('CONSENT_REQUIRED');
    }
  expect(await gameSnapshot(true)).toBe(before);
  for (const docType of ['TERMS', 'PRIVACY'] as const)
    expect(
      (
        await call(
          'legal.agree',
          { docType, version: policy[docType === 'TERMS' ? 'terms' : 'privacy'].version },
          cookie,
        )
      ).status,
    ).toBe(200);
  const other = await db.world.findUniqueOrThrow({ where: { id: formalWorlds[1]! } });
  const worldId = formalWorlds[0]!;
  const creating = track(() =>
    call(
      'general.create',
      { worldId, name: '동의장수', portraitId: null, leadership: 55, strength: 55, intel: 55, politics: 55, charm: 55 },
      cookie,
    ),
  );
  await expect
    .poll(() =>
      db.inputEvent.count({ where: { worldId, userId: actor.id, kind: 'general.create', status: 'PENDING' } }),
    )
    .toBe(1);
  const lease = await acquireLease(db, worldId);
  expect(lease).not.toBeNull();
  try {
    await new TurnLoop(db, lease!).advanceTo(0);
  } finally {
    await releaseLease(db, lease!);
  }
  const result = await creating;
  expect(result.status).toBe(200);
  const generalId = (result.data as { general: { id: number } }).general.id;
  expect(
    (
      await call(
        'turns.set',
        { worldId, revision: 0, slots: Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {} })) },
        cookie,
      )
    ).status,
  ).toBe(200);
  expect(await db.generalTurn.count({ where: { worldId, generalId } })).toBe(30);
  expect(await db.world.findUniqueOrThrow({ where: { id: formalWorlds[1]! } })).toEqual(other);
  expect(await db.general.count({ where: { worldId: formalWorlds[1]!, userId: null } })).toBe(491);
});

it('실제 요청·오류 로그에 계정·비밀번호·세션·DB 오류 원문을 남기지 않는다', async () => {
  await delay(10);
  const text = logs.join('');
  expect(text.includes('request completed')).toBe(true);
  expect(text.includes('500')).toBe(true);
  for (const value of [...sensitive, 'private-consent-failure'])
    expect(text.includes(value), '동의 요청 로그 비밀값 비노출').toBe(false);
});
