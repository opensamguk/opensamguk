import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
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
import { acquireLease, releaseLease, renewLease, type Lease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { stopOwnedChild } from '../apps/engine/src/process-lifecycle';
import { exportReplay, replayArchive, replayToEnd, type ReplayArchiveV3 } from '../apps/engine/src/replay';
import { TICKS_PER_MONTH, ADMIN_END_KIND, type WorldInit } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadReplayState } from '../apps/engine/src/monthly';
import { readAdminEndTick } from '../apps/engine/src/admin/end';
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
const name = 't305_end_' + randomUUID().replaceAll('-', '') + '_test';
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
async function concurrent<T>(work: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(work);
  const failures = settled.filter((row) => row.status === 'rejected').map((row) => row.reason);
  if (failures.length) throw new AggregateError(failures, '동시 작업을 모두 정착한 뒤 실패를 보존합니다.');
  return settled.map((row) => (row as PromiseFulfilledResult<T>).value);
}
async function listenOwned(server: Awaited<ReturnType<typeof buildServer>>) {
  const failures: unknown[] = [];
  await server.ready();
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      return await server.listen({ host: '127.0.0.1', port: randomInt(20_000, 50_000) });
    } catch (error) {
      if (server.server.listening || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      failures.push(error);
    }
  }
  throw new AggregateError(failures, '자기 HTTP listener의 16회 직접 bind가 실패했습니다.');
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
  return track(() =>
    db.user.create({
      data: { email, role, status, passwordHash, emailVerifiedAt: verified ? new Date(now) : null },
    }),
  );
}
async function session(userId: string) {
  const value = newSession(now);
  sensitive.add(value.token);
  await db.session.create({ data: { id: value.id, userId, expiresAt: value.expiresAt } });
  return { id: value.id, cookie: 'sid=' + value.token };
}
async function call(
  path: string,
  input: unknown,
  cookie?: string,
  base = address,
  mutation = false,
  signal?: AbortSignal,
) {
  return track(async () => {
    signal?.throwIfAborted();
    const encoded = JSON.stringify({ 0: input });
    const response = await fetch(
      base + '/trpc/' + path + '?batch=1' + (mutation ? '' : '&input=' + encodeURIComponent(encoded)),
      {
        method: mutation ? 'POST' : 'GET',
        headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
        ...(mutation ? { body: encoded } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      },
    );
    const raw = await response.text();
    signal?.throwIfAborted();
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
  });
}
async function footprint(excludeAccount = false, excludeOperationalLease = false, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const hash = createHash('sha256');
  for (const { tablename } of tables) {
    signal?.throwIfAborted();
    if (excludeAccount && ['User', 'Session', 'ConsentRecord', 'Sanction'].includes(tablename)) continue;
    if (excludeOperationalLease && tablename === 'EngineLease') continue;
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const rows = await db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t`,
    );
    signal?.throwIfAborted();
    hash.update(tablename + '\n' + rows[0]!.body + '\n');
  }
  return hash.digest('hex');
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
    address = await listenOwned(app);
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
  console.info(JSON.stringify({ event: 'admin-end-cleanup', name, oid, connections, dropped, errors: errors.length }));
  if (errors.length) throw new AggregateError([...new Set(errors)], '월드 조회 시험 실행·정리 실패');
});

let initialPromise: Promise<WorldInit> | undefined;
async function freshWorld(human = false, nameOverride?: string) {
  initialPromise ??= loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'admin-end-formal',
  });
  const initial = structuredClone(await initialPromise);
  initial.seed = 'admin-end-' + randomUUID();
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
  const { worldId } = await saveInitialWorld(db, initial, {
    name: nameOverride ?? '관리 종료 ' + worlds.length,
    turnTermMinutes: 60,
    endYear: 300,
  });
  worlds.push(worldId);
  expect(await db.nation.count({ where: { worldId } })).toBe(21);
  expect(await db.general.count({ where: { worldId, userId: null } })).toBe(491);
  await controlClock(db, worldId, 'start');
  if (human) {
    const owner = await user('USER'),
      sid = await session(owner.id);
    const pending = track(() =>
      call(
        'general.create',
        {
          worldId,
          name: '인수장수',
          portraitId: null,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
        },
        sid.cookie,
        address,
        true,
      ),
    );
    await expect.poll(() => db.inputEvent.count({ where: { worldId, status: 'PENDING' } })).toBe(1);
    await advance(worldId, 0);
    expect((await pending).status).toBe(200);
    const general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: owner.id } } });
    expect(await db.generalTurn.count({ where: { worldId, generalId: general.id } })).toBe(30);
  }
  await controlClock(db, worldId, 'pause');
  return worldId;
}
async function command(userId: string, worldId: string) {
  const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  return {
    expectedUserId: userId,
    worldId,
    idempotencyKey: randomUUID(),
    confirmName: world.name,
    expectedRevision: world.clockRevision,
    reason: '전용 시험 종료',
  };
}
function readCommand(value: Awaited<ReturnType<typeof command>>) {
  return { expectedUserId: value.expectedUserId, worldId: value.worldId, idempotencyKey: value.idempotencyKey };
}
async function advance(
  worldId: string,
  tick = 0,
  parentSignal = new AbortController().signal,
  observeLease?: (lease: Lease) => void,
) {
  parentSignal.throwIfAborted();
  const lease = await acquireLease(db, worldId);
  expect(lease).not.toBeNull();
  const controller = new AbortController(),
    signal = AbortSignal.any([controller.signal, parentSignal]),
    failures: unknown[] = [];
  const renewal = (async () => {
    while (!signal.aborted) {
      await delay(3000, undefined, { signal }).catch(() => undefined);
      if (!signal.aborted) await renewLease(db, lease!);
    }
  })();
  void renewal.catch((error) => {
    failures.push(error);
    controller.abort();
  });
  try {
    observeLease?.(lease!);
    await new TurnLoop(db, lease!).advanceTo(tick, signal);
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
  if (failures.length) throw new AggregateError(failures, '종료 엔진 실행·리스 정리 실패');
}
async function gameState(worldId: string) {
  return db.$transaction((tx) => loadReplayState(tx, worldId));
}
async function gameHash(worldId: string) {
  return hashState(await gameState(worldId));
}

for (const explicitWorld of [false, true])
  it('실제 engine CLI 정상 기동·종료·재기동 중복0 ' + explicitWorld, async (signal) => {
    const worldId = await freshWorld(),
      actor = await user(),
      sid = await session(actor.id),
      value = await command(actor.id, worldId);
    expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).status).toBe(200);
    for (let run = 0; run < 2; run++) {
      signal.throwIfAborted();
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../apps/engine/src/index.ts', import.meta.url)),
          ...(explicitWorld ? ['--world', worldId] : []),
        ],
        {
          env: { ...process.env, DATABASE_URL: target.href, TEST_DATABASE_URL: target.href },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      let output = '',
        spawnFailure: Error | undefined,
        closeResult: { code: number | null; signal: string | null } | undefined;
      // error는 close가 아니다. spawn 직후부터 실패를 보존하고 수명 종료는 실제 close에서만 확인한다.
      child.once('error', (error) => {
        spawnFailure = error;
        errors.push(error);
      });
      const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.once('close', (code, stopped) => {
          closeResult = { code, signal: stopped };
          resolve(closeResult);
        });
      });
      child.stdout?.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        output += String(chunk);
      });
      const observeClose = () =>
        track(async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              closed,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('실제 CLI close를 10초 안에 확인하지 못했습니다.')), 10_000);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        });
      let stopping: Promise<void> | undefined;
      const stop = () => (stopping ??= track(() => stopOwnedChild(child, observeClose())));
      const aborted = () => {
        void stop().catch(() => undefined); // track가 오류 원장을 즉시 소유한다.
      };
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      await withCleanup(
        async () => {
          signal.throwIfAborted();
          await expect
            .poll(
              () => {
                if (spawnFailure) throw spawnFailure;
                signal.throwIfAborted();
                return output.includes('[engine] 시작');
              },
              { timeout: 20000 },
            )
            .toBe(true);
          await expect
            .poll(
              () => db.inputEvent.findFirst({ where: { worldId, kind: ADMIN_END_KIND }, select: { status: true } }),
              { timeout: 20000 },
            )
            .toEqual({ status: 'APPLIED' });
          if (!explicitWorld) await stop();
          expect(await observeClose()).toEqual({ code: 0, signal: null });
          expect(spawnFailure).toBeUndefined();
          const activeLeases = await db.$queryRaw<
            Array<{ count: bigint }>
          >`SELECT count(*) AS count FROM "EngineLease" WHERE "worldId"=${worldId} AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC')`;
          expect(Number(activeLeases[0]!.count)).toBe(0);
          expect(await db.inputEvent.count({ where: { worldId, kind: ADMIN_END_KIND, status: 'APPLIED' } })).toBe(1);
          for (const marker of sensitive) expect(output.includes(marker), 'CLI 비밀 원문 비노출').toBe(false);
        },
        async () => {
          signal.removeEventListener('abort', aborted);
          await stop();
          expect(closeResult, '실제 close 미확인은 성공 정리로 처리하지 않는다').toBeDefined();
        },
      );
    }
  });

for (const category of categories)
  for (const path of ['admin.world.requestEnd', 'admin.world.endRequest'])
    it(
      path + ' ' + category,
      authzCase(path, category, async () => {
        const actor = await user(
            category === 'otherUser' ? 'USER' : 'ADMIN',
            true,
            category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE',
          ),
          sid = await session(actor.id),
          worldId = await freshWorld(),
          value = await command(actor.id, worldId);
        if (path === 'admin.world.endRequest' && category === 'success')
          expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).status).toBe(200);
        const before = await footprint();
        const response = await call(
          path,
          category === 'invalidInput'
            ? { ...value, forged: true }
            : path.endsWith('requestEnd')
              ? value
              : readCommand(value),
          category === 'unauthenticated' ? undefined : sid.cookie,
          address,
          path.endsWith('requestEnd'),
        );
        if (category === 'success')
          expect(response.data).toMatchObject({
            userId: actor.id,
            worldId,
            idempotencyKey: value.idempotencyKey,
            status: 'PENDING',
            action: 'end',
          });
        else {
          expect(response.code).toBe(
            category === 'otherUser' ? 'FORBIDDEN' : category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED',
          );
          expect(await footprint()).toBe(before);
        }
      }),
    );

it('정식 두 월드·사람30칸·한 달 뒤 종료·재생·미확정 일반 입력 정리', async (signal) => {
  const worldId = await freshWorld(true),
    otherId = await freshWorld(true);
  await controlClock(db, worldId, 'resume');
  await advance(worldId, TICKS_PER_MONTH, signal);
  await controlClock(db, worldId, 'pause');
  const actor = await user(),
    sid = await session(actor.id),
    value = await command(actor.id, worldId),
    beforeWorld = await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    beforeHash = await gameHash(worldId),
    otherHash = await gameHash(otherId),
    human = await db.general.findFirstOrThrow({ where: { worldId, userId: { not: null } } });
  const pending = await db.inputEvent.create({
    data: {
      worldId,
      userId: human.userId!,
      generalId: human.id,
      kind: 'general.active',
      payload: {},
      idempotencyKey: randomUUID(),
    },
  });
  const treaty = await db.inputEvent.create({
    data: {
      worldId,
      userId: human.userId!,
      generalId: human.id,
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses: [{ kind: 'peace' }] },
      idempotencyKey: 'treaty.propose:' + randomUUID(),
    },
  });
  expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).status).toBe(200);
  expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toEqual(beforeWorld);
  expect(await gameHash(worldId)).toBe(beforeHash);
  await advance(worldId, beforeWorld.clockTick, signal);
  const saved = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect(saved.status).toBe('ENDED');
  expect(saved.endedAt).not.toBeNull();
  expect(saved.clockTick).toBe(beforeWorld.clockTick);
  expect(saved.clockRevision).toBe(beforeWorld.clockRevision + 1);
  expect(await db.worldResult.count({ where: { worldId } })).toBe(0);
  expect(await gameHash(worldId)).toBe(beforeHash);
  expect(await gameHash(otherId)).toBe(otherHash);
  expect(await db.generalTurn.count({ where: { worldId, generalId: human.id } })).toBe(30);
  expect(await db.inputEvent.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
    status: 'REJECTED',
    result: { code: 'WORLD_CLOSED' },
  });
  expect(await db.inputEvent.count({ where: { worldId, status: 'PENDING' } })).toBe(0);
  expect(await db.inputEvent.findUniqueOrThrow({ where: { id: treaty.id } })).toMatchObject({
    status: 'REJECTED',
    result: { code: 'WORLD_CLOSED' },
  });
  const archive = (await exportReplay(db, worldId)) as ReplayArchiveV3;
  expect(archive.end).toMatchObject({ reason: 'ADMIN_END', winnerNationId: null, finalStateHash: beforeHash });
  expect(archive.afterEnd.map((row) => row.kind)).toContain('general.active');
  expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  expect(replayToEnd(archive)).toEqual(archive.end);
  expect(replayToEnd(JSON.parse(JSON.stringify(archive)))).toEqual(archive.end);
  const summary = await call('world.summary', { worldId }, sid.cookie);
  expect(summary.data).toMatchObject({ status: 'ENDED', result: null, nowTick: saved.clockTick });
  expect((await call('admin.world.endRequest', readCommand(value), sid.cookie)).data).toMatchObject({
    status: 'APPLIED',
    userId: actor.id,
  });
}, 120_000);

it('같은 UUID는 한 번 접수·감사하고 다른 내용·다른 종류와 충돌한다', async () => {
  const worldId = await freshWorld(),
    actor = await user(),
    sid = await session(actor.id),
    value = await command(actor.id, worldId);
  const writes = await concurrent([
    call('admin.world.requestEnd', value, sid.cookie, address, true),
    call('admin.world.requestEnd', value, sid.cookie, address, true),
  ]);
  expect(writes[0]!.data).toEqual(writes[1]!.data);
  expect(await db.inputEvent.count({ where: { worldId, kind: ADMIN_END_KIND } })).toBe(1);
  expect(await db.auditLog.count({ where: { worldId, action: 'world.end.requested' } })).toBe(1);
  for (const patch of [
    { reason: '다른 내용' },
    { confirmName: value.confirmName + ' ' },
    { expectedRevision: value.expectedRevision + 1 },
  ])
    expect((await call('admin.world.requestEnd', { ...value, ...patch }, sid.cookie, address, true)).code).toBe(
      'CONFLICT',
    );
  await advance(worldId);
  const before = await footprint();
  expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).data).toMatchObject({
    status: 'APPLIED',
  });
  expect(await footprint()).toBe(before);
  const foreign = await user(),
    foreignSid = await session(foreign.id);
  expect(
    (await call('admin.world.endRequest', { ...readCommand(value), expectedUserId: foreign.id }, foreignSid.cookie))
      .code,
  ).toBe('NOT_FOUND');
  const otherId = await freshWorld(),
    otherValue = await command(actor.id, otherId);
  expect(
    (
      await call(
        'admin.world.requestClock',
        {
          expectedUserId: actor.id,
          worldId: otherId,
          idempotencyKey: otherValue.idempotencyKey,
          action: 'resume',
          reason: '다른 종류',
        },
        sid.cookie,
        address,
        true,
      )
    ).status,
  ).toBe(200);
  const otherBefore = await footprint();
  expect((await call('admin.world.requestEnd', otherValue, sid.cookie, address, true)).code).toBe('CONFLICT');
  expect(await footprint()).toBe(otherBefore);
});

it('두 관리자의 동시 종료는 적용1·기각1이며 월간0건 재생이 같다', async () => {
  const worldId = await freshWorld(),
    actors = await concurrent([user(), user()]);
  for (const actor of actors) {
    const sid = await session(actor.id),
      value = await command(actor.id, worldId);
    expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).status).toBe(200);
  }
  const before = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  await advance(worldId);
  expect(await db.inputEvent.count({ where: { worldId, kind: ADMIN_END_KIND, status: 'APPLIED' } })).toBe(1);
  expect(await db.inputEvent.count({ where: { worldId, kind: ADMIN_END_KIND, status: 'REJECTED' } })).toBe(1);
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockRevision).toBe(before.clockRevision + 1);
  const archive = await exportReplay(db, worldId);
  expect(replayToEnd(archive)).toMatchObject({ reason: 'ADMIN_END', finalStateHash: await gameHash(worldId) });
});

for (const mode of ['role', 'status', 'sanction', 'logout', 'revision', 'name', 'world-state'] as const)
  it('접수 뒤 적용 재검사 ' + mode, async () => {
    const worldId = await freshWorld(),
      actor = await user(),
      sid = await session(actor.id),
      value = await command(actor.id, worldId);
    expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).status).toBe(200);
    if (mode === 'role') await db.user.update({ where: { id: actor.id }, data: { role: 'USER' } });
    if (mode === 'status') await db.user.update({ where: { id: actor.id }, data: { status: 'WITHDRAWN' } });
    if (mode === 'sanction')
      await db.sanction.create({ data: { userId: actor.id, createdBy: actor.id, reason: '접수 뒤 제재' } });
    if (mode === 'logout') await db.session.delete({ where: { id: sid.id } });
    if (mode === 'revision')
      await db.world.update({ where: { id: worldId }, data: { clockRevision: { increment: 1 } } });
    if (mode === 'name') await db.world.update({ where: { id: worldId }, data: { name: value.confirmName + '변경' } });
    if (mode === 'world-state') await db.world.update({ where: { id: worldId }, data: { status: 'PREOPEN' } });
    const beforeHash = await gameHash(worldId);
    await advance(worldId);
    const event = await db.inputEvent.findFirstOrThrow({ where: { worldId, kind: ADMIN_END_KIND } });
    expect(event.status).toBe(mode === 'logout' ? 'APPLIED' : 'REJECTED');
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).status).toBe(
      mode === 'logout' ? 'ENDED' : mode === 'world-state' ? 'PREOPEN' : 'PAUSED',
    );
    expect(await gameHash(worldId)).toBe(beforeHash);
  });

for (const mode of ['request-audit', 'apply-audit', 'apply-input'] as const)
  it('실제 PostgreSQL 거부는 전체 원자 변경을 되돌린다 ' + mode, async (signal) => {
    const worldId = await freshWorld(),
      actor = await user(),
      sid = await session(actor.id),
      value = await command(actor.id, worldId);
    if (mode !== 'request-audit')
      expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).status).toBe(200);
    // 엔진 실행권 획득·해제는 게임 트랜잭션 밖의 별도 커밋이다. 해당 표만 분리하고 아래에서 모두 대조한다.
    const separateOperationalLease = mode !== 'request-audit';
    const before = await footprint(false, separateOperationalLease);
    const leasesBefore = await db.engineLease.findMany({ orderBy: { worldId: 'asc' } });
    let usedLease: Lease | undefined;
    await gate.query(
      `CREATE FUNCTION end_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected end write failure'; END $$`,
    );
    const table = mode === 'apply-input' ? 'InputEvent' : 'AuditLog',
      operation = mode === 'apply-input' ? 'UPDATE' : 'INSERT';
    await gate.query(
      `CREATE TRIGGER end_fault BEFORE ${operation} ON "${table}" FOR EACH ROW EXECUTE FUNCTION end_fault()`,
    );
    await withCleanup(
      async () => {
        if (mode === 'request-audit')
          expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).code).toBe(
            'INTERNAL_SERVER_ERROR',
          );
        else
          await expect(
            advance(worldId, 0, signal, (lease) => {
              usedLease = lease;
            }),
          ).rejects.toThrow();
        expect(await footprint(false, separateOperationalLease)).toBe(before);
        const leasesAfter = await db.engineLease.findMany({ orderBy: { worldId: 'asc' } });
        if (separateOperationalLease) {
          expect(usedLease).toBeDefined();
          expect(leasesAfter.filter((row) => row.worldId !== worldId)).toEqual(
            leasesBefore.filter((row) => row.worldId !== worldId),
          );
          const previous = leasesBefore.find((row) => row.worldId === worldId);
          expect(usedLease!.fencingToken).toBe((previous?.fencingToken ?? 0) + 1);
          expect(leasesAfter.find((row) => row.worldId === worldId)).toMatchObject({
            worldId,
            ownerId: usedLease!.ownerId,
            fencingToken: usedLease!.fencingToken,
          });
          const valid = await db.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*) AS count FROM "EngineLease" WHERE "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC')`;
          expect(Number(valid[0]!.count)).toBe(0);
        } else expect(leasesAfter).toEqual(leasesBefore);
      },
      async () => {
        await gate.query(`DROP TRIGGER end_fault ON "${table}"`);
        await gate.query('DROP FUNCTION end_fault()');
      },
    );
  });

it('현재 인증·동의·세션은 접수와 조회 모두 재확인한다', async () => {
  const worldId = await freshWorld(),
    actor = await user(),
    sid = await session(actor.id),
    value = await command(actor.id, worldId);
  expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).status).toBe(200);
  const policy = {
    terms: { version: 'admin-end-test', effectiveAt: new Date(now - 1000).toISOString() },
    privacy: { version: 'admin-end-test', effectiveAt: new Date(now - 1000).toISOString() },
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
      const base = await listenOwned(server);
      for (const path of ['admin.world.requestEnd', 'admin.world.endRequest']) {
        const response = await call(
          path,
          path.endsWith('requestEnd') ? value : readCommand(value),
          sid.cookie,
          base,
          path.endsWith('requestEnd'),
        );
        expect(response.reason).toBe('CONSENT_REQUIRED');
      }
      for (const docType of ['TERMS', 'PRIVACY'])
        expect((await call('legal.agree', { docType, version: 'admin-end-test' }, sid.cookie, base, true)).status).toBe(
          200,
        );
      expect((await call('admin.world.endRequest', readCommand(value), sid.cookie, base)).status).toBe(200);
      await db.user.update({ where: { id: actor.id }, data: { emailVerifiedAt: null } });
      expect((await call('admin.world.requestEnd', value, sid.cookie, base, true)).reason).toBe('EMAIL_NOT_VERIFIED');
      expect((await call('admin.world.endRequest', readCommand(value), sid.cookie, base)).reason).toBe(
        'EMAIL_NOT_VERIFIED',
      );
      await db.user.update({ where: { id: actor.id }, data: { emailVerifiedAt: new Date(now) } });
      await db.session.update({ where: { id: sid.id }, data: { expiresAt: new Date(now - 1) } });
      expect((await call('admin.world.requestEnd', value, sid.cookie, base, true)).code).toBe('UNAUTHORIZED');
      expect((await call('admin.world.endRequest', readCommand(value), sid.cookie, base)).code).toBe('UNAUTHORIZED');
      expect(await db.inputEvent.count({ where: { worldId, kind: ADMIN_END_KIND } })).toBe(1);
    },
    () => server.close(),
  );
});

for (const path of ['admin.world.requestEnd', 'admin.world.endRequest'])
  it('실제 User 잠금 대기 뒤 ADMIN 회수를 재검사한다 ' + path, async () => {
    const worldId = await freshWorld(),
      actor = await user(),
      sid = await session(actor.id),
      value = await command(actor.id, worldId);
    if (path.endsWith('endRequest'))
      expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).status).toBe(200);
    const before = await footprint(true),
      failures: unknown[] = [];
    let pending: ReturnType<typeof call> | undefined;
    await gate.query('BEGIN');
    try {
      await gate.query('UPDATE "User" SET role=\'USER\' WHERE id=$1', [actor.id]);
      pending = track(() =>
        call(
          path,
          path.endsWith('requestEnd') ? value : readCommand(value),
          sid.cookie,
          address,
          path.endsWith('requestEnd'),
        ),
      );
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
      expect((await pending).code).toBe('FORBIDDEN');
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
        const [settled] = await Promise.allSettled([pending]);
        if (settled!.status === 'rejected') failures.push(settled!.reason);
      }
    }
    if (failures.length) throw new AggregateError(failures, '종료 권한 잠금·정리 실패');
  });

it('파손된 일반 대기 입력은 강제로 삭제하거나 성공으로 덮지 않는다', async () => {
  const worldId = await freshWorld(),
    actor = await user(),
    sid = await session(actor.id),
    value = await command(actor.id, worldId);
  const broken = await db.inputEvent.create({
    data: {
      worldId,
      userId: actor.id,
      generalId: 1,
      kind: 'treaty.propose',
      payload: { unexpected: true },
      idempotencyKey: 'treaty.propose:' + randomUUID(),
    },
  });
  expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).status).toBe(200);
  await expect(advance(worldId)).rejects.toThrow();
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).status).toBe('ENDED');
  expect(await db.inputEvent.findUniqueOrThrow({ where: { id: broken.id } })).toMatchObject({
    status: 'PENDING',
    sequence: null,
    tick: null,
    result: null,
  });
});

it('현재 응답·로그는 세션·계정 원문을 노출하지 않는다', async () => {
  const worldId = await freshWorld(),
    actor = await user(),
    sid = await session(actor.id),
    value = await command(actor.id, worldId);
  const response = await call('admin.world.requestEnd', value, sid.cookie, address, true);
  for (const marker of sensitive)
    expect((response.raw + logs.join('')).includes(marker), '자격 증명·계정 원문 비노출').toBe(false);
});

it('조약 종료 tick fallback은 손상·중복·구형식 종료 입력을 거부한다', async () => {
  const worldId = await freshWorld(),
    actor = await user(),
    sid = await session(actor.id),
    value = await command(actor.id, worldId);
  expect((await call('admin.world.requestEnd', value, sid.cookie, address, true)).status).toBe(200);
  await advance(worldId);
  const world = await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    event = await db.inputEvent.findFirstOrThrow({ where: { worldId, kind: ADMIN_END_KIND } });
  expect(await db.$transaction((tx) => readAdminEndTick(tx, world))).toBe(world.clockTick);
  await expect(db.$transaction((tx) => readAdminEndTick(tx, { ...world, replayFormat: 1 }))).rejects.toThrow();
  await expect(
    db.$transaction((tx) => readAdminEndTick(tx, { ...world, clockTick: world.clockTick + 1 })),
  ).rejects.toThrow();
  await expect(db.$transaction((tx) => readAdminEndTick(tx, { ...world, endedAt: null }))).rejects.toThrow();
  await db.$executeRaw`UPDATE "InputEvent" SET result=jsonb_set(result,'{finalStateHash}','"wrong"'::jsonb) WHERE id=${event.id}`;
  await expect(db.$transaction((tx) => readAdminEndTick(tx, world))).rejects.toThrow();
  await db.$executeRaw`UPDATE "InputEvent" SET result=CAST(${JSON.stringify(event.result)} AS jsonb) WHERE id=${event.id}`;
  await db.inputEvent.create({
    data: {
      worldId,
      userId: actor.id,
      kind: ADMIN_END_KIND,
      payload: event.payload!,
      result: event.result!,
      idempotencyKey: randomUUID(),
      status: 'APPLIED',
      tick: event.tick,
      sequence: event.sequence! + 1,
    },
  });
  await expect(db.$transaction((tx) => readAdminEndTick(tx, world))).rejects.toThrow();
});

// 각 반례는 새 정식 월드에서 원래 30초 제한과 전체 DB 무변경 검사를 지킨다.
async function endCase(signal: AbortSignal, nameOverride?: string) {
  signal.throwIfAborted();
  const worldId = await freshWorld(false, nameOverride);
  signal.throwIfAborted();
  const actor = await user();
  signal.throwIfAborted();
  const sid = await session(actor.id);
  signal.throwIfAborted();
  const value = await command(actor.id, worldId);
  signal.throwIfAborted();
  return { worldId, sid, value };
}
for (const invalid of ['account', 'revision', 'name', 'extra-key', 'uuid'] as const) {
  it('실제 정식 종료 거부와 전체 DB 불변: ' + invalid, async (signal) => {
    const { sid, value } = await endCase(signal);
    const patch =
      invalid === 'account'
        ? { expectedUserId: randomUUID() }
        : invalid === 'revision'
          ? { expectedRevision: value.expectedRevision + 1 }
          : invalid === 'name'
            ? { confirmName: value.confirmName + ' ' }
            : invalid === 'extra-key'
              ? { forged: true }
              : { idempotencyKey: 'bad-uuid' };
    const before = await footprint(false, false, signal);
    expect(
      (await call('admin.world.requestEnd', { ...value, ...patch }, sid.cookie, address, true, signal)).status,
    ).not.toBe(200);
    expect(await footprint(false, false, signal)).toBe(before);
  });
}
for (const status of ['PREOPEN', 'RUNNING', 'ENDED'] as const) {
  it('실제 정식 종료의 상태 거부와 전체 DB 불변: ' + status, async (signal) => {
    const { worldId, sid, value } = await endCase(signal);
    await db.world.update({ where: { id: worldId }, data: { status } });
    const before = await footprint(false, false, signal);
    expect((await call('admin.world.requestEnd', value, sid.cookie, address, true, signal)).code).toBe('CONFLICT');
    expect(await footprint(false, false, signal)).toBe(before);
  });
}
it('실제 종료의 구형식 거부와 전체 DB 불변', async (signal) => {
  signal.throwIfAborted();
  const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'admin-end-legacy-refusal' });
  signal.throwIfAborted();
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '구형 종료 보존',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 'legacy',
  });
  worlds.push(worldId);
  signal.throwIfAborted();
  await controlClock(db, worldId, 'start');
  signal.throwIfAborted();
  await controlClock(db, worldId, 'pause');
  const actor = await user();
  signal.throwIfAborted();
  const sid = await session(actor.id),
    value = await command(actor.id, worldId);
  signal.throwIfAborted();
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).replayFormat).toBe(1);
  const before = await footprint(false, false, signal);
  expect((await call('admin.world.requestEnd', value, sid.cookie, address, true, signal)).code).toBe('BAD_REQUEST');
  expect(await footprint(false, false, signal)).toBe(before);
});
it('실제 종료의 손상 origin 거부와 전체 DB 불변', async (signal) => {
  const { worldId, sid, value } = await endCase(signal);
  const original = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  signal.throwIfAborted();
  await withCleanup(
    async () => {
      await db.$executeRaw`UPDATE "World" SET "replayOrigin"=jsonb_set("replayOrigin", '{resourceHash}', '"wrong"'::jsonb) WHERE id=${worldId}`;
      const before = await footprint(false, false, signal);
      expect((await call('admin.world.requestEnd', value, sid.cookie, address, true, signal)).code).toBe('BAD_REQUEST');
      expect(await footprint(false, false, signal)).toBe(before);
    },
    async () => {
      await db.$executeRaw`UPDATE "World" SET "replayOrigin"=CAST(${JSON.stringify(original.replayOrigin)} AS jsonb) WHERE id=${worldId}`;
    },
  );
});
it('실제 긴 이름 월드의 명시 종료는 게임 상태를 보존한다', async (signal) => {
  const { worldId, sid, value } = await endCase(signal, '긴 이름'.repeat(120));
  const before = await gameHash(worldId);
  signal.throwIfAborted();
  expect((await call('admin.world.requestEnd', value, sid.cookie, address, true, signal)).status).toBe(200);
  await advance(worldId, 0, signal);
  signal.throwIfAborted();
  expect(await gameHash(worldId)).toBe(before);
});
