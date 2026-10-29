import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { runSupervisor } from '../apps/engine/src/supervisor';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { TICKS_PER_MONTH } from '../packages/rules/src/index';
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
function it(title: string, work: (signal: AbortSignal) => Promise<void>, timeout?: number) {
  test(
    title,
    ({ onTestFailed }) => {
      const controller = new AbortController();
      // runner timeout은 원래 Promise를 취소하지 않으므로 실제 작업에도 중단을 전한다.
      onTestFailed(() => {
        controller.abort();
        errors.push(new Error('실패한 시험의 자기 DB를 보존합니다.'));
      });
      const pending = track(() => work(controller.signal));
      void pending.then(
        () => controller.abort(),
        () => controller.abort(),
      );
      return pending;
    },
    timeout,
  );
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
  replayFormat: number;
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
    address = await app.listen({ host: '127.0.0.1', port: randomInt(20_000, 50_000) });
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
    select: {
      id: true,
      name: true,
      status: true,
      clockRevision: true,
      replayFormat: true,
      scenarioKey: true,
      presetKey: true,
      turnTermMinutes: true,
    },
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
    await db.world.update({ where: { id: worlds[0]! }, data: { status, presetKey: 'test-preset' } });
    await db.engineHeartbeat.upsert({
      where: { worldId: worlds[0]! },
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
    legalPolicy: policy,
  });
  await withCleanup(
    async () => {
      const base = await server.listen({ host: '127.0.0.1', port: randomInt(20_000, 50_000) }),
        actor = await user(),
        { cookie } = await session(actor.id);
      expect((await call('admin.world.list', undefined, cookie, base)).reason).toBe('CONSENT_REQUIRED');
      const clock = command(actor.id);
      expect((await call('admin.world.requestClock', clock, cookie, base, true)).reason).toBe('CONSENT_REQUIRED');
      expect(
        (
          await call(
            'admin.world.clockRequest',
            { expectedUserId: actor.id, worldId: clock.worldId, idempotencyKey: clock.idempotencyKey },
            cookie,
            base,
          )
        ).reason,
      ).toBe('CONSENT_REQUIRED');
      for (const docType of ['TERMS', 'PRIVACY'])
        expect((await call('legal.agree', { docType, version: 'world-list-test' }, cookie, base, true)).status).toBe(
          200,
        );
      expect(await db.consentRecord.count({ where: { userId: actor.id } })).toBe(2);
      const before = await footprint();
      expect((await call('admin.world.list', undefined, cookie, base)).status).toBe(200);
      expect(await footprint()).toBe(before);
      expect((await call('admin.world.requestClock', clock, cookie, base, true)).status).toBe(200);
      expect(
        (
          await call(
            'admin.world.clockRequest',
            { expectedUserId: actor.id, worldId: clock.worldId, idempotencyKey: clock.idempotencyKey },
            cookie,
            base,
          )
        ).status,
      ).toBe(200);
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

type ClockCommand = {
  expectedUserId: string;
  worldId: string;
  idempotencyKey: string;
  action: 'start' | 'pause' | 'resume';
  reason: string;
};
function command(userId: string, worldId = worlds[1]!, action: ClockCommand['action'] = 'pause'): ClockCommand {
  return { expectedUserId: userId, worldId, action, idempotencyKey: randomUUID(), reason: '시계 운영 점검' };
}
async function clockRead(value: ClockCommand, cookie: string | undefined) {
  return call(
    'admin.world.clockRequest',
    { expectedUserId: value.expectedUserId, worldId: value.worldId, idempotencyKey: value.idempotencyKey },
    cookie,
  );
}
async function applyClock(worldId: string, beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>) {
  const lease = await acquireLease(db, worldId);
  expect(lease).not.toBeNull();
  // 한 관리 입력의 실제 TurnLoop commit을 확인하고 다음 배치로 넘긴다.
  let elapsed = 0;
  return withCleanup(
    async () => {
      const batch = await new TurnLoop(db, lease!, {
        elapsedNow: () => elapsed++ * 1000,
        ...(beforeCommit ? { beforeCommit } : {}),
      }).poll();
      expect(batch.more).toBe(true);
      expect(batch.executions).toEqual([]);
    },
    () => releaseLease(db, lease!),
  );
}
async function advanceWithLease(worldId: string, tick: number, parentSignal: AbortSignal) {
  const lease = await acquireLease(db, worldId);
  expect(lease).not.toBeNull();
  const controller = new AbortController(),
    failures: unknown[] = [],
    signal = AbortSignal.any([controller.signal, parentSignal]);
  const renewal = (async () => {
    while (!signal.aborted) {
      try {
        await delay(1000, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
      if (!signal.aborted) await renewLease(db, lease!);
    }
  })();
  void renewal.catch((error) => {
    failures.push(error);
    controller.abort();
  });
  try {
    signal.throwIfAborted();
    await new TurnLoop(db, lease!).advanceTo(tick, signal);
    signal.throwIfAborted();
  } catch (error) {
    failures.push(error);
  } finally {
    controller.abort();
    await renewal.catch(() => undefined);
    try {
      await releaseLease(db, lease!);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError([...new Set(failures)], '시계 정산 실행·리스 갱신·해제 실패');
}
async function gameRows(worldId: string) {
  const hash = createHash('sha256');
  for (const table of [
    'World',
    'General',
    'GeneralTurn',
    'Nation',
    'City',
    'NationTurn',
    'WorldExtSlice',
    'WorldResult',
  ]) {
    const rows = await db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM "${table}" t WHERE ${table === 'World' ? 'id' : '"worldId"'}=$1`,
      worldId,
    );
    hash.update(table + '\n' + rows[0]!.body + '\n');
  }
  return hash.digest('hex');
}
for (const category of categories)
  for (const path of ['admin.world.requestClock', 'admin.world.clockRequest'])
    it(
      path + ' ' + category,
      authzCase(path, category, async () => {
        const actor = await user(
            category === 'otherUser' ? 'USER' : 'ADMIN',
            true,
            category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE',
          ),
          sid = await session(actor.id),
          value = command(actor.id),
          cookie = category === 'unauthenticated' ? undefined : sid.cookie;
        if (path === 'admin.world.clockRequest' && category === 'success')
          expect((await call('admin.world.requestClock', value, cookie, address, true)).status).toBe(200);
        const before = await footprint(),
          gameBefore = await gameRows(value.worldId),
          otherBefore = await gameRows(worlds[0]!);
        const response = await call(
          path,
          category === 'invalidInput'
            ? { ...value, userId: actor.id }
            : path === 'admin.world.requestClock'
              ? value
              : { expectedUserId: actor.id, worldId: value.worldId, idempotencyKey: value.idempotencyKey },
          cookie,
          address,
          path === 'admin.world.requestClock',
        );
        if (category === 'success') {
          expect(response.status).toBe(200);
          expect(response.data).toMatchObject({
            action: 'pause',
            status: 'PENDING',
            tick: null,
            sequence: null,
            result: null,
          });
          const event = await db.inputEvent.findUniqueOrThrow({
            where: {
              worldId_userId_idempotencyKey: {
                worldId: value.worldId,
                userId: actor.id,
                idempotencyKey: value.idempotencyKey,
              },
            },
          });
          expect(event.userId).toBe(actor.id);
          expect(await db.auditLog.count({ where: { inputEventId: event.id, action: 'world.pause.requested' } })).toBe(
            1,
          );
          if (path === 'admin.world.clockRequest') expect(await footprint()).toBe(before);
        } else {
          expect(response.code).toBe(
            category === 'otherUser' ? 'FORBIDDEN' : category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED',
          );
          expect(await footprint()).toBe(before);
        }
        expect(await gameRows(value.worldId)).toBe(gameBefore);
        expect(await gameRows(worlds[0]!)).toBe(otherBefore);
      }),
    );

it('정식 두 월드에서 같은 접수·엔진 pause/resume·중복 기각·다른 월드 격리', async () => {
  const actor = await user(),
    sid = await session(actor.id),
    worldId = worlds[1]!,
    value = command(actor.id),
    before = await gameRows(worldId),
    other = await gameRows(worlds[0]!);
  const replies = await Promise.all([
    track(() => call('admin.world.requestClock', value, sid.cookie, address, true)),
    track(() => call('admin.world.requestClock', value, sid.cookie, address, true)),
  ]);
  expect(replies.map((r) => r.status)).toEqual([200, 200]);
  expect(replies[0]!.data).toEqual(replies[1]!.data);
  expect(await gameRows(worldId)).toBe(before);
  expect(
    await db.inputEvent.count({ where: { worldId, userId: actor.id, idempotencyKey: value.idempotencyKey } }),
  ).toBe(1);
  const conflict = await call('admin.world.requestClock', { ...value, reason: '다른 사유' }, sid.cookie, address, true);
  expect(conflict.code).toBe('CONFLICT');
  // 앞의 권한 성공 표가 접수한 pause부터 실제 운영 엔진이 차례로 처리한다.
  const pending = await db.inputEvent.count({ where: { worldId, status: 'PENDING', kind: 'admin.world.pause' } });
  for (let i = 0; i < pending; i++) await applyClock(worldId);
  const receipt = await clockRead(value, sid.cookie);
  expect(receipt.status).toBe(200);
  expect(receipt.data).toMatchObject({ status: 'REJECTED', result: { code: 'WORLD_STATE_CHANGED' } });
  const completed = await db.inputEvent.findMany({
    where: { worldId, kind: 'admin.world.pause', status: { not: 'PENDING' } },
  });
  expect(completed.filter((e) => e.status === 'APPLIED')).toHaveLength(1);
  expect(completed.filter((e) => e.status === 'REJECTED').length).toBe(pending - 1);
  const paused = await controlClock(db, worldId, 'status');
  expect(paused.status).toBe('PAUSED');
  expect((await controlClock(db, worldId, 'status', Date.now() + 86400000)).tick).toBe(paused.tick);
  const resume = command(actor.id, worldId, 'resume');
  expect((await call('admin.world.requestClock', resume, sid.cookie, address, true)).status).toBe(200);
  await applyClock(worldId);
  expect((await clockRead(resume, sid.cookie)).data).toMatchObject({ status: 'APPLIED' });
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).status).toBe('RUNNING');
  expect(await gameRows(worlds[0]!)).toBe(other);
  for (const id of worlds) {
    expect(await db.nation.count({ where: { worldId: id } })).toBe(21);
    expect(await db.general.count({ where: { worldId: id, userId: null } })).toBe(491);
    const human = await db.general.findFirstOrThrow({ where: { worldId: id, userId: { not: null } } });
    expect(await db.generalTurn.count({ where: { worldId: id, generalId: human.id } })).toBe(30);
  }
});

it('접수 뒤 역할 회수는 기각하고 로그아웃한 유효 관리자의 접수는 남긴다', async () => {
  const worldId = worlds[1]!;
  for (const mode of ['role', 'logout'] as const) {
    const actor = await user(),
      sid = await session(actor.id),
      value = command(actor.id, worldId);
    expect((await call('admin.world.requestClock', value, sid.cookie, address, true)).status).toBe(200);
    if (mode === 'role') await db.user.update({ where: { id: actor.id }, data: { role: 'USER' } });
    else await db.session.delete({ where: { id: sid.id } });
    await applyClock(worldId);
    const event = await db.inputEvent.findUniqueOrThrow({
      where: { worldId_userId_idempotencyKey: { worldId, userId: actor.id, idempotencyKey: value.idempotencyKey } },
    });
    expect(event.status).toBe(mode === 'role' ? 'REJECTED' : 'APPLIED');
    if (mode === 'role') expect(event.result).toEqual({ code: 'ADMIN_REQUIRED', message: '관리자 권한이 없습니다.' });
    expect(await db.auditLog.count({ where: { inputEventId: event.id } })).toBe(2);
  }
});

it('감사 쓰기 실패는 실제 상태·입력·순번을 함께 롤백하고 같은 요청으로 복구한다', async () => {
  const actor = await user(),
    sid = await session(actor.id),
    worldId = worlds[1]!,
    value = command(actor.id, worldId, 'resume');
  expect((await call('admin.world.requestClock', value, sid.cookie, address, true)).status).toBe(200);
  const before = await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    event = await db.inputEvent.findUniqueOrThrow({
      where: { worldId_userId_idempotencyKey: { worldId, userId: actor.id, idempotencyKey: value.idempotencyKey } },
    });
  await gate.query(
    `CREATE FUNCTION test_clock_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='world.resume.applied' THEN RAISE EXCEPTION 'clock audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_clock_audit_failure BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION test_clock_audit_failure()`,
  );
  await withCleanup(
    async () => {
      await expect(applyClock(worldId)).rejects.toThrow();
      expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toEqual(before);
      expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event);
      expect(await db.auditLog.count({ where: { inputEventId: event.id } })).toBe(1);
    },
    async () => {
      await gate.query('DROP TRIGGER test_clock_audit_failure ON "AuditLog"; DROP FUNCTION test_clock_audit_failure()');
    },
  );
  expect((await call('admin.world.requestClock', value, sid.cookie, address, true)).data).toMatchObject({
    requestId: String(event.id),
    status: 'PENDING',
  });
  await applyClock(worldId);
  expect((await clockRead(value, sid.cookie)).data).toMatchObject({ status: 'APPLIED' });
});

it('PREOPEN 정식191년 월드를 실제 감독 자식이 발견해 시작하고 사람30칸을 만든다', async () => {
  const initial = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'admin-clock-supervisor',
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
    name: '감독 시작 인수',
    turnTermMinutes: 60,
    endYear: 201,
  });
  worlds.push(worldId);
  const actor = await user(),
    sid = await session(actor.id),
    value = command(actor.id, worldId, 'start'),
    before = await gameRows(worldId);
  expect((await call('admin.world.requestClock', value, sid.cookie, address, true)).data).toMatchObject({
    status: 'PENDING',
  });
  expect(await gameRows(worldId)).toBe(before);
  const controller = new AbortController(),
    children: ChildProcess[] = [],
    started: string[] = [];
  const managed = track(() =>
    runSupervisor(db, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.kind === 'started') started.push(event.worldId!);
      },
      spawnChild: (id) => {
        // 운영 자식을 실제 실행하되 이 파일이 소유한 별도 DB를 명시한다.
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', fileURLToPath(new URL('../apps/engine/src/index.ts', import.meta.url)), '--world', id],
          {
            env: { ...process.env, DATABASE_URL: target.href, TEST_DATABASE_URL: target.href },
            windowsHide: true,
            stdio: process.platform === 'win32' ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
          },
        );
        children.push(child);
        return child;
      },
    }),
  );
  await withCleanup(
    async () => {
      await expect
        .poll(async () => (await clockRead(value, sid.cookie)).data, { timeout: 20000 })
        .toMatchObject({ status: 'APPLIED', action: 'start' });
      expect(started).toContain(worldId);
      const human = await user('USER'),
        humanSession = await session(human.id);
      expect(
        (
          await call(
            'general.create',
            {
              worldId,
              name: '감독사람',
              portraitId: null,
              leadership: 55,
              strength: 55,
              intel: 55,
              politics: 55,
              charm: 55,
            },
            humanSession.cookie,
            address,
            true,
          )
        ).status,
      ).toBe(200);
      await expect.poll(() => db.general.count({ where: { worldId, userId: human.id } }), { timeout: 10_000 }).toBe(1);
      const general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: human.id } } });
      expect(await db.generalTurn.count({ where: { worldId, generalId: general.id } })).toBe(30);
      expect(await db.general.count({ where: { worldId, userId: null } })).toBe(491);
      expect(await db.nation.count({ where: { worldId } })).toBe(21);
      const receipt = await db.inputEvent.findUniqueOrThrow({
        where: { worldId_userId_idempotencyKey: { worldId, userId: actor.id, idempotencyKey: value.idempotencyKey } },
      });
      expect(await db.auditLog.count({ where: { inputEventId: receipt.id } })).toBe(2);
    },
    async () => {
      controller.abort();
      await managed;
      const failures = children.filter((child) => child.exitCode !== 0);
      expect(failures).toEqual([]);
    },
  );
});

it('행위자 위조·없는 대상·잘못된 현재 상태는 접수하지 않는다', async () => {
  const actor = await user(),
    sid = await session(actor.id),
    other = await user();
  for (const value of [command(other.id), command(actor.id, randomUUID()), command(actor.id, worlds[0]!, 'start')]) {
    const before = await footprint(),
      response = await call('admin.world.requestClock', value, sid.cookie, address, true);
    expect(response.code).toBe(
      value.expectedUserId !== actor.id ? 'UNAUTHORIZED' : value.worldId === worlds[0] ? 'CONFLICT' : 'NOT_FOUND',
    );
    expect(await footprint()).toBe(before);
  }
});

let clockAcceptance: {
  worldId: string;
  other: string;
  boundary: number;
  phase: number;
  phaseMs: number[];
  stateHash?: string;
};
function clockPhase(phase: number) {
  if (errors.length || !clockAcceptance || clockAcceptance.phase !== phase)
    throw new Error('앞선 시계 인수 단계가 완료되지 않았습니다.');
  return clockAcceptance;
}
it('월간 정산 대기 PAUSED에서도 재개를 적용하고 중복 요청을 보존한다', async (signal) => {
  if (errors.length || clockAcceptance) throw new Error('시계 인수 준비 상태가 다릅니다.');
  const began = performance.now();
  const worldId = worlds[1]!,
    other = await gameRows(worlds[0]!),
    actor = await user(),
    sid = await session(actor.id);
  await controlClock(db, worldId, 'pause');
  const paused = await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    boundary = paused.monthlyTick + TICKS_PER_MONTH;
  // 월간 catch-up 시계만 자기 DB에 주입하며 정산·입력·장수는 실제 엔진이 처리한다.
  await db.world.update({ where: { id: worldId }, data: { clockTick: boundary, clockRevision: { increment: 1 } } });
  const value = command(actor.id, worldId, 'resume');
  expect((await call('admin.world.requestClock', value, sid.cookie, address, true)).status).toBe(200);
  await applyClock(worldId);
  const receipt = await clockRead(value, sid.cookie);
  expect(receipt.data).toMatchObject({ status: 'APPLIED', tick: boundary });
  const count = await db.auditLog.count({ where: { worldId } });
  expect((await call('admin.world.requestClock', value, sid.cookie, address, true)).data).toEqual(receipt.data);
  expect(await db.auditLog.count({ where: { worldId } })).toBe(count);
  signal.throwIfAborted();
  clockAcceptance = { worldId, other, boundary, phase: 1, phaseMs: [performance.now() - began] };
});

it('정식491명과 사람30칸의 월말을 새 엔진·리스로 끝까지 정산한다', async (signal) => {
  const began = performance.now(),
    state = clockPhase(1),
    { worldId, boundary } = state;
  expect(await db.general.count({ where: { worldId, userId: null } })).toBe(491);
  const human = await db.general.findFirstOrThrow({ where: { worldId, userId: { not: null } } });
  expect(await db.generalTurn.count({ where: { worldId, generalId: human.id } })).toBe(30);
  // 새 TurnLoop·새 리스로 재시작해 미정산 턴과 월말을 완료한다.
  await advanceWithLease(worldId, boundary, signal);
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).monthlyTick).toBe(boundary);
  const snapshot = await db.yearbookSnapshot.findUniqueOrThrow({
    where: { worldId_tick: { worldId, tick: boundary } },
  });
  signal.throwIfAborted();
  state.stateHash = snapshot.stateHash;
  state.phaseMs.push(performance.now() - began);
  state.phase = 2;
}, 120_000);

it('실제 월말 수출의 동일시드 재생 두 번과 다른 월드 불변을 대조한다', async (signal) => {
  const began = performance.now(),
    state = clockPhase(2),
    { worldId, boundary, other } = state;
  signal.throwIfAborted();
  const archive = await exportReplay(db, worldId),
    months = boundary / TICKS_PER_MONTH;
  const first = replayArchive(archive, months),
    second = replayArchive(archive, months);
  expect(first).toEqual(second);
  expect(first.at(-1)).toEqual({ tick: boundary, stateHash: state.stateHash });
  const completed = await db.inputEvent.count({
    where: { worldId, status: 'PENDING', kind: { startsWith: 'admin.world.' } },
  });
  expect(completed).toBe(0);
  expect(await gameRows(worlds[0]!)).toBe(other);
  signal.throwIfAborted();
  state.phaseMs.push(performance.now() - began);
  state.phase = 3;
  console.info(
    JSON.stringify({
      event: 'admin-clock-formal-month',
      phaseMs: state.phaseMs.map(Math.round),
      totalPhaseMs: Math.round(state.phaseMs.reduce((sum, ms) => sum + ms, 0)),
      npc: 491,
      humanSlots: 30,
    }),
  );
});

it('새 시계 경로도 미인증·로그아웃·만료·현재 역할·전체 제재를 다시 검사한다', async () => {
  for (const mode of ['unverified', 'logout', 'expiry', 'role', 'sanction'] as const) {
    const actor = await user('ADMIN', mode !== 'unverified'),
      sid = await session(actor.id),
      value = command(actor.id);
    if (mode === 'logout') await db.session.delete({ where: { id: sid.id } });
    if (mode === 'expiry') await db.session.update({ where: { id: sid.id }, data: { expiresAt: new Date(now - 1) } });
    if (mode === 'role') await db.user.update({ where: { id: actor.id }, data: { role: 'USER' } });
    if (mode === 'sanction')
      await db.sanction.create({ data: { userId: actor.id, createdBy: actor.id, reason: '현재 권한 시험' } });
    const before = await footprint(),
      write = await call('admin.world.requestClock', value, sid.cookie, address, true),
      read = await clockRead(value, sid.cookie);
    expect(write.code).toBe(mode === 'unverified' || mode === 'role' ? 'FORBIDDEN' : 'UNAUTHORIZED');
    expect(read.code).toBe(write.code);
    if (mode === 'unverified') {
      expect(write.reason).toBe('EMAIL_NOT_VERIFIED');
      expect(read.reason).toBe('EMAIL_NOT_VERIFIED');
    }
    expect(await footprint()).toBe(before);
  }
});

it('엔진 적용 전에 비활성·전체 제재가 생기면 접수한 입력도 기각한다', async () => {
  for (const mode of ['status', 'sanction'] as const) {
    const actor = await user(),
      sid = await session(actor.id),
      value = command(actor.id);
    expect((await call('admin.world.requestClock', value, sid.cookie, address, true)).status).toBe(200);
    if (mode === 'status') await db.user.update({ where: { id: actor.id }, data: { status: 'SANCTIONED' } });
    else await db.sanction.create({ data: { userId: actor.id, createdBy: actor.id, reason: '적용 전 제재' } });
    const before = await db.world.findUniqueOrThrow({ where: { id: value.worldId } });
    await applyClock(value.worldId);
    const after = await db.world.findUniqueOrThrow({ where: { id: value.worldId } }),
      event = await db.inputEvent.findUniqueOrThrow({
        where: {
          worldId_userId_idempotencyKey: {
            worldId: value.worldId,
            userId: actor.id,
            idempotencyKey: value.idempotencyKey,
          },
        },
      });
    expect(after.status).toBe(before.status);
    expect(after.clockTick).toBe(before.clockTick);
    expect(after.clockRevision).toBe(before.clockRevision);
    expect(event.status).toBe('REJECTED');
    expect(event.result).toMatchObject({ code: mode === 'status' ? 'ACTOR_INACTIVE' : 'ACTOR_SANCTIONED' });
    expect(await db.auditLog.count({ where: { inputEventId: event.id } })).toBe(2);
  }
});

it('기존 형식 월드의 시계 API는 데이터·입력·감사를 바꾸지 않고 거부한다', async () => {
  const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'clock-legacy-refusal' });
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '구형 보존',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 'legacy',
  });
  worlds.push(worldId);
  const actor = await user(),
    sid = await session(actor.id),
    value = command(actor.id, worldId, 'start'),
    before = await footprint();
  expect((await call('admin.world.requestClock', value, sid.cookie, address, true)).code).toBe('BAD_REQUEST');
  expect(await footprint()).toBe(before);
});
