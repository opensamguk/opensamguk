import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
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
const name = 't305_worlds_' + randomUUID().replaceAll('-', '') + '_test';
const target = new URL(source),
  adminUrl = new URL(source);
target.pathname = '/' + name;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href }),
  gate = new Client({ connectionString: target.href }),
  db = createDb(target.href),
  now = Date.now(),
  origin = 'http://127.0.0.1:5173';
const executions = new Set<Promise<unknown>>(),
  errors: unknown[] = [],
  worlds: string[] = [],
  logs: string[] = [],
  sensitive = new Set<string>();
let app: Awaited<ReturnType<typeof buildServer>> | undefined,
  address: string,
  oid: string | undefined,
  passwordHash: string,
  gatePid: number;
function track<T>(work: () => Promise<T>) {
  const pending = Promise.resolve().then(work);
  executions.add(pending);
  void pending.then(
    () => executions.delete(pending),
    (error) => {
      errors.push(error);
      executions.delete(pending);
    },
  );
  return pending;
}
async function settle() {
  while (executions.size) await Promise.allSettled([...executions]);
}
function it(title: string, work: () => Promise<void>) {
  test(title, () => track(work));
}
async function withCleanup(work: () => Promise<void>, cleanup: () => Promise<void>) {
  const failures: unknown[] = [];
  try {
    await work();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '본문과 자기 자원 정리 실패');
}
beforeEach(settle);
async function user(role: 'USER' | 'ADMIN' = 'ADMIN', verified = true, status: 'ACTIVE' | 'SANCTIONED' = 'ACTIVE') {
  const email = randomUUID() + '@example.test';
  sensitive.add(email);
  return db.user.create({
    data: { email, role, status, passwordHash, emailVerifiedAt: verified ? new Date(now) : null },
  });
}
async function session(userId: string) {
  const value = newSession(now);
  sensitive.add(value.token);
  await db.session.create({ data: { id: value.id, userId, expiresAt: value.expiresAt } });
  return { id: value.id, cookie: 'sid=' + value.token };
}
async function call(path: string, input: unknown, cookie?: string, base = address, mutation = false) {
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    base + '/trpc/' + path + '?batch=1' + (mutation ? '' : '&input=' + encodeURIComponent(encoded)),
    {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const raw = await response.text();
  const [result] = JSON.parse(raw) as Array<{
    result?: { data: unknown };
    error?: { data: { code: string; reason: string | null } };
  }>;
  return {
    status: response.status,
    data: result?.result?.data,
    code: result?.error?.data.code,
    reason: result?.error?.data.reason,
    raw,
  };
}
async function footprint(excludeAccount = false) {
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const hash = createHash('sha256');
  for (const { tablename } of tables) {
    if (excludeAccount && ['User', 'Session', 'ConsentRecord', 'Sanction'].includes(tablename)) continue;
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const rows = await db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t`,
    );
    hash.update(tablename + '\n' + rows[0]!.body + '\n');
  }
  return hash.digest('hex');
}
type Row = {
  id: string;
  name: string;
  status: string;
  scenarioKey: string;
  presetKey: string | null;
  turnTermMinutes: number;
  humanGenerals: number;
  heartbeat: { at: string; lastTick: number; lagMs: number; lastError: string | null } | null;
};
beforeAll(() =>
  track(async () => {
    await admin.connect();
    expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows).toHaveLength(0);
    await admin.query(`CREATE DATABASE "${name}"`);
    oid = String((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows[0]!.oid);
    await gate.connect();
    gatePid = Number((await gate.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
    const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
    for (const migration of (await readdir(migrations)).filter((value) => /^\d{14}_/.test(value)).sort())
      await gate.query(await readFile(new URL(migration + '/migration.sql', migrations), 'utf8'));
    passwordHash = await hashPassword(randomUUID());
    sensitive.add(passwordHash);
    app = await buildServer({
      db,
      now: () => now,
      publicOrigin: origin,
      emailVerificationRequired: true,
      logStream: {
        write: (chunk: string) => {
          logs.push(chunk);
        },
      },
    });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  }),
);
afterAll(async () => {
  await settle();
  for (const close of [() => app?.close(), () => gate.end(), () => db.$disconnect()]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  let dropped = false,
    connections: number | undefined;
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
    JSON.stringify({ event: 'admin-worlds-cleanup', name, oid, connections, dropped, errors: errors.length }),
  );
  if (errors.length) throw new AggregateError([...new Set(errors)], '월드 조회 시험 실행·정리 실패');
});

for (const category of categories)
  it(
    'admin.world.list ' + category,
    authzCase('admin.world.list', category, async () => {
      const actor = await user(
        category === 'otherUser' ? 'USER' : 'ADMIN',
        true,
        category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE',
      );
      const cookie = category === 'unauthenticated' ? undefined : (await session(actor.id)).cookie;
      const before = await footprint();
      const response = await call(
        'admin.world.list',
        category === 'invalidInput' ? { userId: actor.id } : undefined,
        cookie,
      );
      if (category === 'success') {
        expect(response.status).toBe(200);
        expect(response.data).toEqual([]);
      } else
        expect(response.code).toBe(
          category === 'otherUser' ? 'FORBIDDEN' : category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED',
        );
      expect(await footprint()).toBe(before);
    }),
  );

for (const index of [0, 1])
  it('정식191 월드와 사람 장수30칸을 실제 API·엔진으로 준비한다 ' + index, async () => {
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'admin-world-list-' + index,
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
      name: '관리 월드' + index,
      turnTermMinutes: 60,
      endYear: 201,
    });
    worlds.push(worldId);
    const humanUser = await user('USER'),
      { cookie } = await session(humanUser.id);
    await controlClock(db, worldId, 'start');
    const pending = track(() =>
      call(
        'general.create',
        {
          worldId,
          name: '조회사람',
          portraitId: null,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
        },
        cookie,
        address,
        true,
      ),
    );
    try {
      await expect
        .poll(() => db.inputEvent.count({ where: { worldId, userId: humanUser.id, status: 'PENDING' } }))
        .toBe(1);
      const lease = await acquireLease(db, worldId);
      expect(lease).not.toBeNull();
      await withCleanup(
        () => new TurnLoop(db, lease!).advanceTo(0).then(() => undefined),
        () => releaseLease(db, lease!),
      );
      expect((await pending).status).toBe(200);
      expect(await db.nation.count({ where: { worldId } })).toBe(21);
      expect(await db.general.count({ where: { worldId, userId: null } })).toBe(491);
      const general = await db.general.findUniqueOrThrow({
        where: { worldId_userId: { worldId, userId: humanUser.id } },
      });
      expect(await db.generalTurn.count({ where: { worldId, generalId: general.id } })).toBe(30);
    } finally {
      await Promise.allSettled([pending]);
    }
  });

it('정식 두 월드의 명시 열·사람 수·heartbeat를 반환하고 모든 표와 감사를 보존한다', async () => {
  const actor = await user(),
    { cookie } = await session(actor.id);
  const expected = await db.world.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, name: true, status: true, scenarioKey: true, presetKey: true, turnTermMinutes: true },
  });
  const before = await footprint(),
    response = await call('admin.world.list', undefined, cookie);
  expect(response.status).toBe(200);
  expect(response.data).toEqual(expected.map((row) => ({ ...row, humanGenerals: 1, heartbeat: null })));
  expect(await footprint()).toBe(before);
  expect((response.data as Row[]).map((row) => row.id).sort()).toEqual([...worlds].sort());
});

it('상태·프리셋·정상/오류 heartbeat의 읽기 계약과 오류 원문 비노출', async () => {
  const actor = await user(),
    { cookie } = await session(actor.id),
    marker = 'private-engine-error-' + randomUUID();
  sensitive.add(marker);
  // 제어 실행기의 증거가 아니다. 목록 표시만 검사하는 상태·진단 자료를 자기 DB에 설정한다.
  for (const status of ['PREOPEN', 'RUNNING', 'PAUSED', 'ENDED'] as const) {
    await db.world.update({ where: { id: worlds[0] }, data: { status, presetKey: 'test-preset' } });
    await db.engineHeartbeat.upsert({
      where: { worldId: worlds[0] },
      create: {
        worldId: worlds[0]!,
        at: new Date(now),
        lastTick: 37,
        lagMs: 123,
        lastError: status === 'ENDED' ? marker : null,
      },
      update: { lastError: status === 'ENDED' ? marker : null },
    });
    const before = await footprint(),
      response = await call('admin.world.list', undefined, cookie);
    expect(response.status).toBe(200);
    expect((response.data as Row[]).find((row) => row.id === worlds[0])).toMatchObject({
      status,
      presetKey: 'test-preset',
      humanGenerals: 1,
      heartbeat: {
        at: new Date(now).toISOString(),
        lastTick: 37,
        lagMs: 123,
        lastError: status === 'ENDED' ? '엔진 오류가 기록되어 있습니다.' : null,
      },
    });
    expect((response.data as Row[]).find((row) => row.id === worlds[1])!.heartbeat).toBeNull();
    expect(response.raw.includes(marker), '내부 오류 원문 비노출').toBe(false);
    expect(await footprint()).toBe(before);
  }
});

it('미인증·역할 회수·로그아웃·만료·전체 제재는 결과와 DB 쓰기 없이 거부한다', async () => {
  const unverified = await user('ADMIN', false),
    unverifiedSession = await session(unverified.id);
  expect((await call('admin.world.list', undefined, unverifiedSession.cookie)).reason).toBe('EMAIL_NOT_VERIFIED');
  for (const mode of ['role', 'logout', 'expiry', 'sanction'] as const) {
    const actor = await user(),
      sid = await session(actor.id);
    if (mode === 'role') await db.user.update({ where: { id: actor.id }, data: { role: 'USER' } });
    if (mode === 'logout') await db.session.delete({ where: { id: sid.id } });
    if (mode === 'expiry') await db.session.update({ where: { id: sid.id }, data: { expiresAt: new Date(now - 1) } });
    if (mode === 'sanction')
      await db.sanction.create({ data: { userId: actor.id, createdBy: actor.id, reason: '시험' } });
    const before = await footprint(),
      response = await call('admin.world.list', undefined, sid.cookie);
    expect(response.code).toBe(mode === 'role' ? 'FORBIDDEN' : 'UNAUTHORIZED');
    expect(response.data).toBeUndefined();
    expect(await footprint()).toBe(before);
  }
});

it('별도 시험 정책의 현재 두 판에 실제 동의한 관리자만 목록을 받는다', async () => {
  const policy = {
    terms: { version: 'world-list-test', effectiveAt: new Date(now - 1000).toISOString() },
    privacy: { version: 'world-list-test', effectiveAt: new Date(now - 1000).toISOString() },
  };
  const server = await buildServer({
    db,
    logging: false,
    now: () => now,
    publicOrigin: origin,
    emailVerificationRequired: true,
    legalPolicyRequired: true,
    legalPolicy: policy,
  });
  await withCleanup(
    async () => {
      const base = await server.listen({ host: '127.0.0.1', port: 0 }),
        actor = await user(),
        { cookie } = await session(actor.id);
      expect((await call('admin.world.list', undefined, cookie, base)).reason).toBe('CONSENT_REQUIRED');
      for (const docType of ['TERMS', 'PRIVACY'])
        expect((await call('legal.agree', { docType, version: 'world-list-test' }, cookie, base, true)).status).toBe(
          200,
        );
      expect(await db.consentRecord.count({ where: { userId: actor.id } })).toBe(2);
      const before = await footprint();
      expect((await call('admin.world.list', undefined, cookie, base)).status).toBe(200);
      expect(await footprint()).toBe(before);
    },
    () => server.close(),
  );
});

for (const mode of ['role', 'session-delete', 'session-expiry'] as const)
  it('실제 잠금 대기 뒤 권한을 잃은 요청은 목록을 내보내지 않는다 ' + mode, async () => {
    const actor = await user(),
      sid = await session(actor.id),
      before = await footprint(true);
    let pending: ReturnType<typeof call> | undefined;
    const failures: unknown[] = [];
    await gate.query('BEGIN');
    try {
      if (mode === 'role') await gate.query('UPDATE "User" SET role=\'USER\' WHERE id=$1', [actor.id]);
      else if (mode === 'session-delete') await gate.query('DELETE FROM "Session" WHERE id=$1', [sid.id]);
      else await gate.query('UPDATE "Session" SET "expiresAt"=now()-interval \'1 minute\' WHERE id=$1', [sid.id]);
      pending = track(() => call('admin.world.list', undefined, sid.cookie));
      await expect
        .poll(async () =>
          Number(
            (
              await admin.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))",
                [name, gatePid],
              )
            ).rows[0]!.n,
          ),
        )
        .toBe(1);
      await gate.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(500);
      expect(response.code).toBe('INTERNAL_SERVER_ERROR');
      expect(response.data).toBeUndefined();
      for (const id of worlds) expect(response.raw).not.toContain(id);
      expect(await footprint(true)).toBe(before);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await gate.query('ROLLBACK');
      } catch (error) {
        failures.push(error);
      }
      if (pending) {
        const [result] = await Promise.allSettled([pending]);
        if (result!.status === 'rejected') failures.push(result!.reason);
      }
    }
    if (failures.length) throw new AggregateError([...new Set(failures)], '잠금 검사 본문·정착·정리 실패');
  });

it('응답·서버 로그에 계정·자격 증명·내부 오류 원문을 넣지 않는다', async () => {
  const actor = await user(),
    sid = await session(actor.id),
    response = await call('admin.world.list', undefined, sid.cookie);
  expect(response.status).toBe(200);
  for (const value of sensitive) {
    expect(response.raw.includes(value), '자격 증명 응답 비노출').toBe(false);
    expect(logs.join('').includes(value), '자격 증명 로그 비노출').toBe(false);
  }
  expect(
    /passwordHash|emailVerifiedAt|sessionId|consents|initialStateHash|engineLease|replayOrigin/.test(response.raw),
    '비공개 필드 비노출',
  ).toBe(false);
});
