import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb, notifyWorld } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { newAccountToken } from '../apps/server/src/auth/accountToken';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
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
const name = 't302_withdrawal_' + randomUUID().replaceAll('-', '') + '_test';
const target = new URL(source),
  adminUrl = new URL(source);
target.pathname = '/' + name;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href }),
  gate = new Client({ connectionString: target.href }),
  db = createDb(target.href);
const origin = 'http://127.0.0.1:5173',
  password = randomUUID(),
  executions = new Set<Promise<unknown>>(),
  errors: unknown[] = [],
  logs: string[] = [],
  sensitive = new Set<string>([password]);
const policy = {
  terms: { version: 'withdraw-terms-test', effectiveAt: '2026-01-01T00:00:00Z', bodyText: '자기 시험 약관' },
  privacy: {
    version: 'withdraw-privacy-test',
    effectiveAt: '2026-01-01T00:00:00Z',
    bodyText: '자기 시험의 묘비·동의·게임·제재·감사 보존안',
  },
};
type Api = { app: Awaited<ReturnType<typeof buildServer>>; address: string; origin: string };
const apps: Api[] = [],
  worlds: string[] = [];
let api: Api,
  defaultApi: Api,
  productionApi: Api,
  mismatchApi: Api,
  passwordHash: string,
  oid: string | undefined,
  gatePid: number,
  humanUser: string,
  otherHumanUser: string;
function track<T>(work: () => Promise<T>) {
  const promise = Promise.resolve().then(work);
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
async function settle() {
  while (executions.size) await Promise.allSettled([...executions]);
}
function it(title: string, work: () => Promise<void>) {
  test(title, ({ onTestFailed }) => {
    onTestFailed(() => {
      errors.push(new Error('실패한 시험의 자기 DB를 보존합니다.'));
    });
    return track(work);
  });
}
beforeEach(settle);
async function start(
  withdrawal: boolean,
  production = false,
  privacyVersion = policy.privacy.version,
  now?: () => number,
) {
  const publicOrigin = production ? 'https://withdrawal.example.test' : origin;
  const app = await buildServer({
    db,
    publicOrigin,
    production,
    secureCookies: production,
    emailVerificationRequired: true,
    legalPolicy: policy,
    trustProxy: true,
    ...(now ? { now } : {}),
    realtime: { connectionString: target.href, heartbeatMs: 60_000 },
    ...(withdrawal ? { withdrawalPolicy: { scheme: 'tombstone-v1' as const, privacyVersion } } : {}),
    logStream: {
      write(chunk: string) {
        logs.push(chunk);
      },
    },
  });
  const result = { app, address: '', origin: publicOrigin };
  apps.push(result);
  result.address = await app.listen({ host: '127.0.0.1', port: randomInt(20_000, 50_000) });
  return result;
}
async function user(
  status: 'ACTIVE' | 'SANCTIONED' = 'ACTIVE',
  verified = true,
  consent = true,
  email = randomUUID() + '@example.test',
) {
  sensitive.add(email);
  const value = await db.user.create({
    data: { email, passwordHash, status, emailVerifiedAt: verified ? new Date() : null },
  });
  if (consent)
    await db.consentRecord.createMany({
      data: [
        { userId: value.id, docType: 'TERMS', version: policy.terms.version },
        { userId: value.id, docType: 'PRIVACY', version: policy.privacy.version },
      ],
    });
  return value;
}
async function session(userId: string, expiresAt?: Date) {
  const value = newSession(Date.now());
  sensitive.add(value.token);
  await db.session.create({ data: { id: value.id, userId, expiresAt: expiresAt ?? value.expiresAt } });
  return { id: value.id, cookie: 'sid=' + value.token };
}
const clients = new Map<string, string>();
async function call(path: string, input: unknown, cookie?: string, selected = api, mutation = true, fixedIp?: string) {
  // 자기 loopback 프록시에서 독립 시험의 주소를 구분하며 실제 한도는 아래에서 별도 대조한다.
  if (cookie && !clients.has(cookie)) {
    expect(clients.size).toBeLessThan(250);
    clients.set(cookie, '192.0.2.' + (clients.size + 1));
  }
  const ip = fixedIp ?? (cookie ? clients.get(cookie)! : '192.0.2.254');
  sensitive.add(ip);
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    selected.address + '/trpc/' + path + '?batch=1' + (mutation ? '' : '&input=' + encodeURIComponent(encoded)),
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin: selected.origin,
        'x-forwarded-for': ip,
        ...(cookie ? { cookie } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
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
    status: response.status,
    code: body?.error?.data.code,
    reason: body?.error?.data.reason,
    data: body?.result?.data,
    raw,
    cookies: response.headers.get('set-cookie') ?? '',
    retryAfter: response.headers.get('retry-after'),
  };
}
const withdraw = (id: string, cookie: string, selected = api, value: string = password) =>
  call('account.withdraw', { expectedUserId: id, password: value }, cookie, selected);
async function footprint(excludeAccount = false) {
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const hash = createHash('sha256');
  for (const { tablename } of tables) {
    if (excludeAccount && ['User', 'Session', 'AccountToken'].includes(tablename)) continue;
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const rows = await db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t`,
    );
    hash.update(tablename + '\n' + rows[0]!.body + '\n');
  }
  return hash.digest('hex');
}
async function otherAccounts(userId: string) {
  const rows = await Promise.all([
    db.user.findMany({ where: { id: { not: userId } }, orderBy: { id: 'asc' } }),
    db.session.findMany({ where: { userId: { not: userId } }, orderBy: { id: 'asc' } }),
    db.accountToken.findMany({ where: { userId: { not: userId } }, orderBy: { id: 'asc' } }),
  ]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
type Stream = { controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> };
async function openStream(selected: Api, cookie: string, worldId: string, streams: Stream[]) {
  const controller = new AbortController();
  try {
    const response = await fetch(selected.address + '/sse?worldId=' + worldId, {
      headers: { origin: selected.origin, cookie },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    streams.push({ controller, reader });
    expect(new TextDecoder().decode((await reader.read()).value).includes('event: ready')).toBe(true);
    return reader;
  } catch (error) {
    controller.abort();
    throw error;
  }
}
async function closeStreams(streams: Stream[]) {
  for (const stream of streams) stream.controller.abort();
  const failures = (await Promise.allSettled(streams.map((stream) => stream.reader.cancel())))
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
    .filter((error: unknown) => !(error instanceof Error && error.name === 'AbortError'));
  if (failures.length) throw new AggregateError(failures, '실시간 시험 연결 정리 실패');
}
async function tokens(userId: string) {
  for (const [index, purpose] of (['VERIFY_EMAIL', 'RESET_PASSWORD', 'VERIFY_EMAIL'] as const).entries()) {
    const token = newAccountToken(purpose, Date.now());
    sensitive.add(token.token);
    await db.accountToken.create({
      data: {
        id: token.id,
        userId,
        purpose,
        expiresAt: index === 2 ? new Date(0) : token.expiresAt,
        usedAt: index === 1 ? new Date() : null,
      },
    });
  }
}
async function locked(
  userId: string,
  request: () => Promise<Awaited<ReturnType<typeof call>>>,
  change: () => Promise<void>,
) {
  const failures: unknown[] = [];
  let pending: ReturnType<typeof request> | undefined,
    result: Awaited<ReturnType<typeof call>> | undefined,
    open = false;
  try {
    await gate.query('BEGIN');
    open = true;
    await gate.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [userId]);
    pending = track(request);
    await expect
      .poll(
        async () =>
          Number(
            (
              await db.$queryRawUnsafe<Array<{ count: number }>>(
                'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND $2::int=ANY(pg_blocking_pids(pid))',
                name,
                gatePid,
              )
            )[0]!.count,
          ),
        { timeout: 5000 },
      )
      .toBeGreaterThan(0);
    await change();
    await gate.query('COMMIT');
    open = false;
  } catch (error) {
    failures.push(error);
  } finally {
    if (open)
      try {
        await gate.query('ROLLBACK');
      } catch (error) {
        failures.push(error);
      }
    if (pending)
      try {
        result = await pending;
      } catch (error) {
        failures.push(error);
      }
  }
  if (failures.length) throw new AggregateError(failures, '실제 잠금 경합과 정착 실패');
  return result!;
}
beforeAll(() =>
  track(async () => {
    await admin.connect();
    expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows).toHaveLength(0);
    await admin.query(`CREATE DATABASE "${name}"`);
    oid = String((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows[0]!.oid);
    await gate.connect();
    gatePid = Number((await gate.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
    const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
    for (const migration of (await readdir(migrations)).filter((v) => /^\d{14}_/.test(v)).sort())
      await gate.query(await readFile(new URL(migration + '/migration.sql', migrations), 'utf8'));
    passwordHash = await hashPassword(password);
    sensitive.add(passwordHash);
    api = await start(true);
    defaultApi = await start(false);
    productionApi = await start(false, true);
    mismatchApi = await start(true, false, 'different-privacy-test');
  }),
);
afterAll(async () => {
  await settle();
  for (const close of [...apps.map((value) => () => value.app.close()), () => gate.end(), () => db.$disconnect()])
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  let connections: number | undefined,
    dropped = false;
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
  } catch (error) {
    errors.push(error);
  }
  console.info(
    JSON.stringify({ event: 'account-withdrawal-cleanup', name, oid, connections, dropped, errors: errors.length }),
  );
  if (errors.length) throw new AggregateError([...new Set(errors)], '탈퇴 시험 실행·정리 실패');
});

for (const category of categories)
  it(
    'account.withdraw ' + category,
    authzCase('account.withdraw', category, async () => {
      const actor = await user(category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE'),
        sid = await session(actor.id),
        before = await footprint();
      const result = await call(
        'account.withdraw',
        category === 'invalidInput'
          ? { expectedUserId: actor.id, password, userId: actor.id }
          : { expectedUserId: category === 'otherUser' ? randomUUID() : actor.id, password },
        category === 'unauthenticated' ? undefined : sid.cookie,
      );
      if (category === 'success') {
        expect(result.status).toBe(200);
        expect(await db.session.count({ where: { userId: actor.id } })).toBe(0);
      } else {
        expect(result.code).toBe(category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED');
        expect(await footprint()).toBe(before);
      }
    }),
  );

it('미승인 기본 개발·운영 서버는 탈퇴503이고 계정과 모든 행은 그대로다', async () => {
  const actor = await user(),
    sid = await session(actor.id);
  for (const selected of [defaultApi, productionApi, mismatchApi]) {
    const before = await footprint(),
      result = await withdraw(actor.id, sid.cookie, selected);
    expect(result.status).toBe(503);
    expect(await footprint()).toBe(before);
    expect((await call('account.get', undefined, sid.cookie, selected, false)).data).toMatchObject({
      userId: actor.id,
      withdrawalAvailable: false,
    });
  }
});
it('현재 두 본문 판과 맞는 시험 정책만 활성화하고 잘못된 암호·추가 필드는 무변경이다', async () => {
  const actor = await user(),
    sid = await session(actor.id);
  expect((await call('account.get', undefined, sid.cookie, api, false)).data).toMatchObject({
    userId: actor.id,
    withdrawalAvailable: true,
  });
  for (const value of [
    { expectedUserId: actor.id, password: 'x' },
    { expectedUserId: actor.id, password, approved: true },
  ]) {
    const before = await footprint(),
      result = await call('account.withdraw', value, sid.cookie);
    expect(result.code).toBe('approved' in value ? 'BAD_REQUEST' : 'UNAUTHORIZED');
    expect(await footprint()).toBe(before);
  }
});
it('미인증·미동의 본인도 시험 정책 아래에서만 탈퇴하고 모든 토큰을 지운다', async () => {
  const actor = await user('ACTIVE', false, false),
    sid = await session(actor.id);
  await tokens(actor.id);
  expect((await withdraw(actor.id, sid.cookie)).status).toBe(200);
  expect(await db.accountToken.count({ where: { userId: actor.id } })).toBe(0);
});

for (const index of [0, 1])
  it('정식191 두 월드의 사람 장수와 예약30칸을 준비한다 ' + index, async () => {
    if (index === 0) {
      humanUser = (await user()).id;
      otherHumanUser = (await user()).id;
      await tokens(otherHumanUser);
    }
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'account-withdrawal-' + index,
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
    const { worldId } = await saveInitialWorld(db, initial, {
      name: '탈퇴 검증' + index,
      turnTermMinutes: 60,
      endYear: 201,
    });
    worlds.push(worldId);
    await controlClock(db, worldId, 'start');
    const pending = await Promise.all(
      [humanUser, otherHumanUser].map(async (userId, actorIndex) => {
        const sid = await session(userId);
        return {
          request: track(() =>
            call(
              'general.create',
              {
                worldId,
                name: '탈퇴검증' + actorIndex,
                portraitId: null,
                leadership: 55,
                strength: 55,
                intel: 55,
                politics: 55,
                charm: 55,
              },
              sid.cookie,
            ),
          ),
        };
      }),
    );
    let lease: Awaited<ReturnType<typeof acquireLease>> = null;
    const failures: unknown[] = [];
    try {
      await expect
        .poll(() =>
          db.inputEvent.count({ where: { worldId, userId: { in: [humanUser, otherHumanUser] }, status: 'PENDING' } }),
        )
        .toBe(2);
      lease = await acquireLease(db, worldId);
      expect(lease).not.toBeNull();
      await new TurnLoop(db, lease!).advanceTo(0);
    } catch (error) {
      failures.push(error);
    } finally {
      if (lease)
        try {
          await releaseLease(db, lease);
        } catch (error) {
          failures.push(error);
        }
      for (const result of await Promise.allSettled(pending.map((value) => value.request)))
        try {
          if (result.status === 'rejected') failures.push(result.reason);
          else expect(result.value.status).toBe(200);
        } catch (error) {
          failures.push(error);
        }
    }
    if (failures.length) throw new AggregateError(failures, '정식 장수 생성과 실행권 정착');
    expect(await db.general.count({ where: { worldId, userId: null } })).toBe(491);
    for (const userId of [humanUser, otherHumanUser]) {
      const human = await db.general.findFirstOrThrow({ where: { worldId, userId } });
      expect(await db.generalTurn.count({ where: { worldId, generalId: human.id } })).toBe(30);
    }
  });

it('한 번의 탈퇴는 두 정식 월드·예약·원장을 보존하고 본인 세션·토큰만 원자적으로 지운다', async () => {
  expect(worlds).toHaveLength(2);
  const sid = await session(humanUser),
    secondSid = await session(humanUser),
    otherSid = await session(otherHumanUser);
  await tokens(humanUser);
  await db.sanction.create({
    data: { userId: humanUser, worldId: worlds[0]!, createdBy: humanUser, reason: '시험 보존 사유' },
  });
  await db.auditLog.create({
    data: {
      actorKind: 'ADMIN',
      actorUserId: humanUser,
      action: 'test.retention',
      targetType: 'User',
      targetId: humanUser,
      payload: { test: true },
    },
  });
  const old = await db.user.findUniqueOrThrow({ where: { id: humanUser } }),
    streams: Stream[] = [],
    failures: unknown[] = [];
  try {
    const own = await openStream(api, sid.cookie, worlds[0]!, streams),
      remote = await openStream(defaultApi, secondSid.cookie, worlds[0]!, streams),
      other = await openStream(defaultApi, otherSid.cookie, worlds[0]!, streams),
      before = await footprint(true),
      otherBefore = await otherAccounts(humanUser),
      started = Date.now(),
      result = await withdraw(humanUser, sid.cookie);
    expect(result.status).toBe(200);
    expect(result.cookies).toContain('sid=;');
    expect(result.cookies).toContain('did=;');
    expect((await Promise.all([own.read(), remote.read()])).map((value) => value.done)).toEqual([true, true]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await footprint(true)).toBe(before);
    expect(await otherAccounts(humanUser)).toBe(otherBefore);
    const general = await db.general.findFirstOrThrow({ where: { worldId: worlds[0]!, userId: otherHumanUser } });
    expect(await notifyWorld(db, worlds[0]!, { kind: 'turn.result', target: { generalId: general.id } })).toBe(true);
    const frame = await other.read();
    expect(frame.done).toBe(false);
    expect(new TextDecoder().decode(frame.value).includes('event: turn.result')).toBe(true);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await closeStreams(streams);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '탈퇴 결과와 실제 연결 정리 실패');
  const saved = await db.user.findUniqueOrThrow({ where: { id: humanUser } });
  expect(saved.status).toBe('WITHDRAWN');
  expect(saved.email === `withdrawn+${humanUser}@invalid`).toBe(true);
  expect(saved.passwordHash !== old.passwordHash).toBe(true);
  expect(saved.emailVerifiedAt).toBeNull();
  expect(await db.session.count({ where: { userId: humanUser } })).toBe(0);
  expect(await db.accountToken.count({ where: { userId: humanUser } })).toBe(0);
  expect((await call('auth.login', { email: old.email, password })).status).toBe(401);
  const signup = await call('auth.signup', {
    email: old.email,
    password,
    consents: { terms: policy.terms.version, privacy: policy.privacy.version },
  });
  expect(signup.status).toBe(200);
  const renewed = (signup.data as { user: { id: string } }).user.id;
  expect(renewed).not.toBe(humanUser);
  expect(await db.general.count({ where: { userId: renewed } })).toBe(0);
});

for (const mode of ['password', 'logout', 'status', 'sanction'] as const)
  it('실제 User 잠금 대기 뒤 ' + mode + ' 변경은 탈퇴를 취소한다', async () => {
    const actor = await user(),
      sid = await session(actor.id);
    await tokens(actor.id);
    const before = await footprint(true),
      tokenCount = await db.accountToken.count({ where: { userId: actor.id } }),
      changedHash = mode === 'password' ? await hashPassword(randomUUID()) : undefined;
    const response = await locked(
      actor.id,
      () => withdraw(actor.id, sid.cookie),
      async () => {
        if (mode === 'password')
          await gate.query('UPDATE "User" SET "passwordHash"=$2 WHERE id=$1', [actor.id, changedHash]);
        if (mode === 'logout') await gate.query('DELETE FROM "Session" WHERE id=$1', [sid.id]);
        if (mode === 'status') await gate.query('UPDATE "User" SET status=\'SANCTIONED\' WHERE id=$1', [actor.id]);
        if (mode === 'sanction')
          await gate.query('INSERT INTO "Sanction" (id,"userId",reason,"createdBy") VALUES ($1,$2,$3,$2)', [
            randomUUID(),
            actor.id,
            '시험 전체 제재',
          ]);
      },
    );
    expect(response.status).toBe(401);
    expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).status).not.toBe('WITHDRAWN');
    expect(await db.accountToken.count({ where: { userId: actor.id } })).toBe(tokenCount);
    if (mode !== 'sanction') expect(await footprint(true)).toBe(before);
  });
it('요청 당시 유효한 세션도 실제 잠금 대기 중 자연 만료되면 탈퇴하지 않는다', async () => {
  const actor = await user(),
    expiry = new Date(Date.now() + 3000),
    sid = await session(actor.id, expiry);
  await tokens(actor.id);
  const before = await footprint();
  const result = await locked(
    actor.id,
    () => withdraw(actor.id, sid.cookie),
    async () => {
      await expect
        .poll(
          async () =>
            Number(
              (await gate.query('SELECT (clock_timestamp() >= $1::timestamptz)::int AS expired', [expiry])).rows[0]!
                .expired,
            ),
          { timeout: 5000 },
        )
        .toBe(1);
    },
  );
  expect(result.status).toBe(401);
  expect(await footprint()).toBe(before);
});
it('실제 토큰 삭제 거부는 계정 치환·모든 세션 삭제까지 함께 롤백한다', async () => {
  const actor = await db.user.findUniqueOrThrow({ where: { id: otherHumanUser } }),
    sid = await session(actor.id),
    secondSid = await session(actor.id);
  await tokens(actor.id);
  await gate.query(
    "CREATE FUNCTION withdrawal_deny_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'withdrawal test denial'; END $$",
  );
  await gate.query(
    'CREATE TRIGGER withdrawal_deny_delete BEFORE DELETE ON "AccountToken" FOR EACH ROW EXECUTE FUNCTION withdrawal_deny_delete()',
  );
  const failures: unknown[] = [],
    streams: Stream[] = [];
  try {
    const readers = [
      await openStream(api, sid.cookie, worlds[0]!, streams),
      await openStream(defaultApi, secondSid.cookie, worlds[0]!, streams),
    ];
    const before = await footprint();
    expect((await withdraw(actor.id, sid.cookie)).status).toBe(500);
    expect(await footprint()).toBe(before);
    const general = await db.general.findFirstOrThrow({ where: { worldId: worlds[0]!, userId: actor.id } });
    expect(await notifyWorld(db, worlds[0]!, { kind: 'turn.result', target: { generalId: general.id } })).toBe(true);
    for (const reader of readers) {
      const frame = await reader.read();
      expect(frame.done).toBe(false);
      expect(new TextDecoder().decode(frame.value).includes('event: turn.result')).toBe(true);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await closeStreams(streams);
    } catch (error) {
      failures.push(error);
    }
    for (const sql of [
      'DROP TRIGGER withdrawal_deny_delete ON "AccountToken"',
      'DROP FUNCTION withdrawal_deny_delete()',
    ])
      try {
        await gate.query(sql);
      } catch (error) {
        failures.push(error);
      }
  }
  if (failures.length) throw new AggregateError(failures, '실제 삭제 거부와 정리');
  expect((await withdraw(actor.id, sid.cookie)).status).toBe(200);
});

it('예약 묘비 신규 가입은 거부하고 기존 충돌 계정의 세션·자료와 로그인 입력 경계는 보존한다', async () => {
  const actor = await user(),
    sid = await session(actor.id),
    email = `withdrawn+${actor.id}@invalid`;
  const before = await footprint();
  expect(
    (
      await call('auth.signup', {
        email,
        password,
        consents: { terms: policy.terms.version, privacy: policy.privacy.version },
      })
    ).status,
  ).toBe(400);
  expect(await footprint()).toBe(before);
  const occupant = await user('ACTIVE', true, true, email),
    occupantSid = await session(occupant.id);
  await tokens(occupant.id);
  // 이 SQL 경계 자료의 단일 이름 도메인은 변경 전 로그인 형식도 허용하지 않는다.
  const legacyLogin = await call('auth.login', { email, password });
  expect(legacyLogin.status).toBe(400);
  expect(legacyLogin.code).toBe('BAD_REQUEST');
  const collisionBefore = await footprint();
  expect((await withdraw(actor.id, sid.cookie)).status).toBe(409);
  expect(await footprint()).toBe(collisionBefore);
  const legacyAfter = await call('auth.login', { email, password });
  expect({ status: legacyAfter.status, code: legacyAfter.code }).toEqual({
    status: legacyLogin.status,
    code: legacyLogin.code,
  });
  expect((await call('account.get', undefined, occupantSid.cookie, api, false)).status).toBe(200);
  expect((await call('auth.login', { email: actor.email, password })).status).toBe(200);
  expect((await db.user.findUniqueOrThrow({ where: { id: occupant.id } })).status).toBe('ACTIVE');
});
it('자기 계정이 이미 자기 묘비 주소를 쓰는 경계는 상대 계정을 바꾸지 않는다', async () => {
  const actor = await user(),
    sid = await session(actor.id);
  await db.user.update({ where: { id: actor.id }, data: { email: `withdrawn+${actor.id}@invalid` } });
  expect((await withdraw(actor.id, sid.cookie)).status).toBe(200);
  expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).status).toBe('WITHDRAWN');
});
it('외부의 미확정 묘비 INSERT와 unique 경합해도 상대 계정은 유지하고 탈퇴 전체를 롤백한다', async () => {
  const actor = await user(),
    sid = await session(actor.id),
    otherId = randomUUID(),
    email = `withdrawn+${actor.id}@invalid`;
  await tokens(actor.id);
  const old = await db.user.findUniqueOrThrow({ where: { id: actor.id } }),
    games = await footprint(true),
    failures: unknown[] = [];
  let open = false,
    pending: ReturnType<typeof withdraw> | undefined;
  try {
    await gate.query('BEGIN');
    open = true;
    await gate.query('INSERT INTO "User" (id,email,"passwordHash") VALUES ($1,$2,$3)', [otherId, email, passwordHash]);
    pending = track(() => withdraw(actor.id, sid.cookie));
    await expect
      .poll(
        async () =>
          Number(
            (
              await db.$queryRawUnsafe<Array<{ count: number }>>(
                'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND $2::int=ANY(pg_blocking_pids(pid))',
                name,
                gatePid,
              )
            )[0]!.count,
          ),
        { timeout: 5000 },
      )
      .toBeGreaterThan(0);
    await gate.query('COMMIT');
    open = false;
  } catch (error) {
    failures.push(error);
  } finally {
    if (open)
      try {
        await gate.query('ROLLBACK');
      } catch (error) {
        failures.push(error);
      }
    if (pending)
      try {
        expect((await pending).status).toBe(409);
      } catch (error) {
        failures.push(error);
      }
  }
  if (failures.length) throw new AggregateError(failures, '묘비 unique 경합 정착');
  expect(await footprint(true)).toBe(games);
  expect(
    createHash('sha256')
      .update(JSON.stringify(await db.user.findUniqueOrThrow({ where: { id: actor.id } })))
      .digest('hex'),
  ).toBe(createHash('sha256').update(JSON.stringify(old)).digest('hex'));
  expect(await db.session.count({ where: { id: sid.id } })).toBe(1);
  expect(await db.accountToken.count({ where: { userId: actor.id } })).toBe(3);
  expect((await db.user.findUniqueOrThrow({ where: { id: otherId } })).status).toBe('ACTIVE');
});
it('같은 본인의 동시 두 탈퇴는 한 번만 확정하고 나머지는 현재 세션으로 거부한다', async () => {
  const actor = await user(),
    sid = await session(actor.id),
    before = await footprint(true);
  const requests = [track(() => withdraw(actor.id, sid.cookie)), track(() => withdraw(actor.id, sid.cookie))],
    settled = await Promise.allSettled(requests);
  expect(settled.every((v) => v.status === 'fulfilled')).toBe(true);
  const results = settled
    .filter((v): v is PromiseFulfilledResult<Awaited<ReturnType<typeof withdraw>>> => v.status === 'fulfilled')
    .map((v) => v.value.status)
    .sort();
  expect(results).toEqual([200, 401]);
  expect(await footprint(true)).toBe(before);
  expect(await db.session.count({ where: { userId: actor.id } })).toBe(0);
});
it('실제 이메일 토큰 소비와 탈퇴가 겹쳐도 탈퇴 뒤 인증·토큰이 되살아나지 않는다', async () => {
  const actor = await user('ACTIVE', false),
    sid = await session(actor.id),
    token = newAccountToken('VERIFY_EMAIL', Date.now());
  sensitive.add(token.token);
  await db.accountToken.create({
    data: { id: token.id, userId: actor.id, purpose: 'VERIFY_EMAIL', expiresAt: token.expiresAt },
  });
  const results = await Promise.allSettled([
    track(() => withdraw(actor.id, sid.cookie)),
    track(() => call('account.verifyEmail', { token: token.token })),
  ]);
  expect(results.every((value) => value.status === 'fulfilled')).toBe(true);
  const first = results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof withdraw>>>,
    second = results[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof call>>>;
  expect(first.value.status).toBe(200);
  expect([200, 400]).toContain(second.value.status);
  const saved = await db.user.findUniqueOrThrow({ where: { id: actor.id } });
  expect(saved.status).toBe('WITHDRAWN');
  expect(saved.emailVerifiedAt).toBeNull();
  expect(await db.accountToken.count({ where: { userId: actor.id } })).toBe(0);
});
it('실제 동시 로그인은 탈퇴 전에만 확정할 수 있고 탈퇴 뒤 세션은 남지 않는다', async () => {
  for (let index = 0; index < 5; index++) {
    const actor = await user(),
      sid = await session(actor.id);
    const results = await Promise.allSettled([
      track(() => withdraw(actor.id, sid.cookie)),
      track(() => call('auth.login', { email: actor.email, password })),
    ]);
    expect(results.every((value) => value.status === 'fulfilled')).toBe(true);
    const first = results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof withdraw>>>,
      second = results[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof call>>>;
    expect(first.value.status).toBe(200);
    expect([200, 401]).toContain(second.value.status);
    expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).status).toBe('WITHDRAWN');
    expect(await db.session.count({ where: { userId: actor.id } })).toBe(0);
  }
});
it('실제 사용자5회·IP15회 한도를 유지하고 다음 잘못된 암호 시도는429다', async () => {
  // DB 무변경 검사가 15분 고정 창 경계를 지나도 이 요청열은 같은 창에 속한다.
  const fixedNow = Date.now();
  const selected = await start(true, false, policy.privacy.version, () => fixedNow);
  const actor = await user(),
    sid = await session(actor.id);
  for (let index = 0; index < 6; index++) {
    const result = await withdraw(actor.id, sid.cookie, selected, 'x');
    expect(result.status).toBe(index < 5 ? 401 : 429);
    if (index === 5) expect(Number(result.retryAfter)).toBeGreaterThan(0);
  }
  for (let index = 0; index < 16; index++) {
    const other = await user(),
      otherSession = await session(other.id),
      before = await footprint();
    const result = await call(
      'account.withdraw',
      { expectedUserId: other.id, password: 'x' },
      otherSession.cookie,
      selected,
      true,
      '192.0.2.253',
    );
    expect(result.status).toBe(index < 15 ? 401 : 429);
    expect(await footprint()).toBe(before);
  }
});
it('비밀번호·토큰·이메일·해시는 서버 요청 로그에 추가하지 않는다', async () => {
  const text = logs.join('');
  for (const value of sensitive) expect(text.includes(value), '시험 비밀값 비노출').toBe(false);
});
