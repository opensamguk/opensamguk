import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { worldCreateIntent, TICKS_PER_MONTH, type ReplayOriginV3 } from '../packages/rules/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { initializeResources } from './init-resources';
import { initializeIntegrationResources } from './integration-resources';
import { savePreparedInitialWorld } from '../apps/engine/src/world/persistence';
import { prepareWorldReset } from '../apps/engine/src/admin/resetPreparation';
import { processWorldCreateRequest } from '../apps/engine/src/admin/createRequests';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';
import { OwnedChildScope } from './test-support/owned-child-scope';
import { stopOwnedChild } from '../apps/engine/src/process-lifecycle';

// RESET-C source only. city-resources-v1/all-nine city profile is a separate post-T integration gate.
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
const name = 't305_reset_preparation_' + randomUUID().replaceAll('-', '') + '_test',
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
const childScope = new OwnedChildScope({
  label: 'admin-reset-preparation-cli',
  traceDir: process.env.OPENSAMGUK_CHILD_TRACE_DIR,
  repoRoot: fileURLToPath(new URL('../', import.meta.url)),
});
const children: Array<{ stop: () => Promise<void>; closed: boolean; stdoutEnded: boolean; stderrEnded: boolean }> = [];
let failed = false,
  oid: string | undefined,
  app: Awaited<ReturnType<typeof buildServer>> | undefined,
  address = '',
  ownerId = '',
  sourceFootprint = '';
const oldWorlds: string[] = [],
  newWorlds: string[] = [],
  monthHashes: string[] = [];
const features = [
  'campaign-v1',
  'five-stats',
  'operational-map',
  'personnel',
  'policy',
  'stratagem-basic',
  'treaty',
  'treaty-break',
  'treaty-trade',
].sort();
const origin = 'http://127.0.0.1:5173';
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
  if (!/^t305_reset_preparation_[a-f0-9]{32}_test$/.test(expectedName) || !/^[1-9]\d*$/.test(expectedOid))
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
async function finiteClosed<T>(closed: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('실제 CLI close 미확인: DB 보존')), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function publishedCli(signal: AbortSignal) {
  signal.throwIfAborted();
  const owned = childScope.start(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../apps/engine/src/cli/createWorld.ts', import.meta.url)),
      '--published',
      '--scenario',
      'integration191',
      '--map',
      'integration',
      '--stat-rules',
      'five-stats',
      '--portrait-map',
      '191-map',
      '--rule-features',
      features.join(','),
      '--seed',
      'reset-original-cli',
      '--name',
      '초기화 보존 CLI',
      '--turn-term',
      '30',
      '--end-year',
      '200',
    ],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, DATABASE_URL: target.href },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
      killSignal: 'SIGKILL',
    },
  );
  let stdout = '',
    stderr = '',
    stopping: Promise<void> | undefined;
  const child = owned.child,
    record = {
      closed: false,
      stdoutEnded: false,
      stderrEnded: false,
      stop: () => (stopping ??= track(() => stopOwnedChild(child, finiteClosed(owned.closed, 10000)))),
    };
  children.push(record);
  child.once('error', fail);
  child.stdout!.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout!.once('end', () => {
    record.stdoutEnded = true;
  });
  child.stderr!.once('end', () => {
    record.stderrEnded = true;
  });
  void owned.closed.then(() => {
    record.closed = true;
  });
  const aborted = () => {
    void record.stop().catch(() => {});
  };
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  const failures: unknown[] = [];
  let result: { worldId: string; stateHash: string } | undefined;
  try {
    const exit = await track(() => finiteClosed(owned.closed, 25000));
    signal.throwIfAborted();
    if (exit.error || exit.code !== 0 || exit.signal !== null || !record.stdoutEnded || !record.stderrEnded)
      throw new Error('실제 게시 CLI 정상 close/streams 확인 실패');
    for (const secret of secrets)
      if (secret && (stdout.includes(secret) || stderr.includes(secret))) throw new Error('CLI 비공개 값 노출');
    const parsed: unknown = JSON.parse(stdout.trim());
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('worldId' in parsed) ||
      !('stateHash' in parsed) ||
      typeof parsed.worldId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(parsed.worldId) ||
      typeof parsed.stateHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.stateHash)
    )
      throw new Error('CLI 생성 영수증을 확인하지 못했습니다.');
    result = { worldId: parsed.worldId, stateHash: parsed.stateHash };
  } catch (error) {
    failures.push(error);
  } finally {
    signal.removeEventListener('abort', aborted);
    logs.push(stdout, stderr);
    try {
      await record.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '게시 CLI 본문과 자기 자식 정리 실패');
  return result!;
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
async function fullFootprint() {
  const hash = createHash('sha256');
  for (const table of await tables()) {
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
async function originalFootprint() {
  const hash = createHash('sha256');
  const columns = (
    await checked(() =>
      gate.query(
        "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='worldId' ORDER BY table_name",
      ),
    )
  ).rows.map((row) => String(row.table_name));
  for (const table of ['World', ...columns]) {
    operationSignals.getStore()?.throwIfAborted();
    const quoted = '"' + table.replaceAll('"', '""') + '"',
      column = table === 'World' ? 'id' : 'worldId';
    const rows = await checked(() =>
      gate.query(
        "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM " +
          quoted +
          ' t WHERE "' +
          column +
          '"=ANY($1::text[])',
        [oldWorlds],
      ),
    );
    hash.update(table + '\n' + String(rows.rows[0]!.body) + '\n');
  }
  return hash.digest('hex');
}
async function advance(worldId: string, tick: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const lease = await checked(() => acquireLease(db, worldId), signal);
  if (!lease) throw new Error('자기 리스가 필요합니다.');
  const failures: unknown[] = [];
  try {
    await checked(() => new TurnLoop(db, lease).advanceTo(tick, signal), signal);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await releaseLease(db, lease);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '자기 엔진과 리스 정리 실패');
}
beforeAll(
  () =>
    hook(
      'setup',
      async (signal) => {
        await checked(() => admin.connect(), signal);
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
        const passwordHash = await checked(() => hashPassword(randomUUID()), signal);
        secrets.add(passwordHash);
        const owner = await checked(
          () =>
            db.user.create({
              data: { email: randomUUID() + '@example.test', passwordHash, role: 'ADMIN', emailVerifiedAt: new Date() },
            }),
          signal,
        );
        ownerId = owner.id;
        secrets.add(owner.email);
        app = await checked(
          () =>
            buildServer({
              db,
              publicOrigin: origin,
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
            if (app.server.listening || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
            bindErrors.push(error);
          }
        if (!address) throw new AggregateError(bindErrors, '자기 listener bind 실패');
      },
      true,
    ),
  120000,
);

it('AC-M3-04 실제 게시 CLI는 정식21국491명61거점·v3·CLI 감사를 남긴다', async (signal) => {
  const saved = await checked(() => publishedCli(signal));
  oldWorlds.push(saved.worldId);
  const world = await checked(() => db.world.findUniqueOrThrow({ where: { id: saved.worldId } }));
  expect(world).toMatchObject({
    name: '초기화 보존 CLI',
    seed: 'reset-original-cli',
    replayFormat: 3,
    status: 'PREOPEN',
    initialStateHash: saved.stateHash,
  });
  const audits = await checked(() =>
    db.auditLog.findMany({ where: { worldId: saved.worldId, actorKind: 'CLI', action: 'world.create.applied' } }),
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    targetType: 'World',
    targetId: saved.worldId,
    payload: { stateHash: saved.stateHash },
  });
  expect(await checked(() => db.nation.count({ where: { worldId: saved.worldId } }))).toBe(21);
  expect(await checked(() => db.general.count({ where: { worldId: saved.worldId } }))).toBe(491);
  expect(await checked(() => db.city.count({ where: { worldId: saved.worldId } }))).toBe(61);
});
it('AC-M3-04 B 생성 소비자의 DONE manifest를 가진 정식 두 번째 원본을 준비한다', async (signal) => {
  const idempotencyKey = randomUUID(),
    plannedWorldId = randomUUID();
  const intent = worldCreateIntent({
    expectedUserId: ownerId,
    idempotencyKey,
    name: '초기화 보존 B',
    scenarioKey: 'integration191',
    mapKey: 'integration',
    statRulesKey: 'five-stats',
    portraitMapKey: '191-map',
    ruleFeatures: features,
    seed: 'reset-original-b',
    turnTermMinutes: 30,
    endYear: 200,
  });
  await checked(() =>
    db.worldCreateRequest.create({
      data: {
        requestedBy: ownerId,
        idempotencyKey,
        plannedWorldId,
        version: 1,
        intent,
        intentHash: hashState(intent),
        effectiveSeed: intent.seed!,
      },
    }),
  );
  expect(await checked(() => processWorldCreateRequest(db, signal))).toBe(true);
  const request = await checked(() => db.worldCreateRequest.findUniqueOrThrow({ where: { plannedWorldId } }));
  expect(request.status).toBe('DONE');
  expect(request.worldId).toBe(plannedWorldId);
  oldWorlds.push(plannedWorldId);
});
it('AC-M3-04 실제 API와 엔진으로 기존 사람 장수·30예약·입력 기록을 남긴다', async (signal) => {
  const worldId = oldWorlds[0]!;
  await checked(() => controlClock(db, worldId, 'start'));
  const session = newSession(Date.now());
  secrets.add(session.token);
  await checked(() => db.session.create({ data: { id: session.id, userId: ownerId, expiresAt: session.expiresAt } }));
  const request = track(async () => {
    signal.throwIfAborted();
    const response = await fetch(address + '/trpc/general.create', {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { origin, cookie: 'sid=' + session.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        worldId,
        name: '보존사람',
        portraitId: null,
        leadership: 55,
        strength: 55,
        intel: 55,
        politics: 55,
        charm: 55,
      }),
    });
    await response.text();
    signal.throwIfAborted();
    return response.status;
  });
  const settled = Promise.allSettled([request]),
    failures: unknown[] = [];
  try {
    await checked(() =>
      expect
        .poll(() => checked(() => db.inputEvent.count({ where: { worldId, userId: ownerId, status: 'PENDING' } })), {
          timeout: 10000,
        })
        .toBe(1),
    );
    await advance(worldId, 0, signal);
  } catch (error) {
    failures.push(error);
  }
  for (const result of await settled) if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, '사람 생성 본문 정착 실패');
  expect(await request).toBe(200);
  const human = await checked(() =>
    db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: ownerId } } }),
  );
  expect(await checked(() => db.generalTurn.count({ where: { worldId, generalId: human.id } }))).toBe(30);
  expect(await checked(() => db.inputEvent.count({ where: { worldId, status: 'APPLIED' } }))).toBeGreaterThan(0);
  await checked(() => controlClock(db, worldId, 'pause'));
  sourceFootprint = await originalFootprint();
});
it('AC-M3-04 기존 사람 월드의 정식 한 달과 재생·30예약을 실제 보존 기준으로 남긴다', async (signal) => {
  const worldId = oldWorlds[0]!;
  await checked(() => controlClock(db, worldId, 'resume'));
  await advance(worldId, TICKS_PER_MONTH, signal);
  await checked(() => controlClock(db, worldId, 'pause'));
  const world = await checked(() => db.world.findUniqueOrThrow({ where: { id: worldId } }));
  expect(world.monthlyTick).toBe(TICKS_PER_MONTH);
  const human = await checked(() =>
    db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: ownerId } } }),
  );
  expect(await checked(() => db.generalTurn.count({ where: { worldId, generalId: human.id } }))).toBe(30);
  expect(replayArchive(await checked(() => exportReplay(db, worldId)), 1)).toHaveLength(1);
  sourceFootprint = await originalFootprint();
}, 120000);
it('AC-M3-04 CLI/B 원 시드 복원과 두 번의 새 시드 준비는 모든 기존 표를 쓰지 않는다', async (signal) => {
  const before = await fullFootprint();
  for (const worldId of oldWorlds) {
    const world = await checked(() => db.world.findUniqueOrThrow({ where: { id: worldId } }));
    const same = await checked(() => prepareWorldReset(db, worldId, world.seed, signal));
    expect(same.evidence.initialHash).toBe(world.initialStateHash);
    const first = await checked(() => prepareWorldReset(db, worldId, 'reset-new-fixed', signal)),
      second = await checked(() => prepareWorldReset(db, worldId, 'reset-new-fixed', signal));
    expect(first.evidence).toEqual(second.evidence);
    expect(first.evidence.resources).toHaveLength(5);
    expect(first.evidence.initialHash).not.toBe(world.initialStateHash);
    expect(first.evidence.provenance.kind).toBe(worldId === oldWorlds[0] ? 'cli' : 'request');
  }
  expect(await fullFootprint()).toBe(before);
  expect(await originalFootprint()).toBe(sourceFootprint);
});
it('AC-M3-04 새 prepared를 저장한 독립 두 월드는 PREOPEN·491 NPC만 가지고 원본 사람을 복사하지 않는다', async (signal) => {
  for (let index = 0; index < 2; index++) {
    signal.throwIfAborted();
    const reset = await checked(() => prepareWorldReset(db, oldWorlds[0]!, 'reset-new-fixed', signal));
    const saved = await checked(() =>
      db.$transaction((tx) => savePreparedInitialWorld(tx, reset.prepared), { timeout: 30000 }),
    );
    newWorlds.push(saved.worldId);
    const world = await checked(() => db.world.findUniqueOrThrow({ where: { id: saved.worldId } }));
    expect(world.status).toBe('PREOPEN');
    expect(world.clockTick).toBe(0);
    expect(world.seed).toBe('reset-new-fixed');
    expect(world.initialStateHash).toBe(reset.evidence.initialHash);
    expect(await checked(() => db.general.count({ where: { worldId: saved.worldId } }))).toBe(491);
    expect(await checked(() => db.general.count({ where: { worldId: saved.worldId, userId: { not: null } } }))).toBe(0);
    expect(await checked(() => db.generalTurn.count({ where: { worldId: saved.worldId } }))).toBe(491 * 30);
    expect((world.replayOrigin as unknown as ReplayOriginV3).initial.generals.every((g) => g.userId === null)).toBe(
      true,
    );
  }
  expect(await originalFootprint()).toBe(sourceFootprint);
});
for (const index of [0, 1])
  it(
    'AC-M3-04 새 시드 정식 독립 월드' + index + ' 한 달 실행과 동일 시드 재생',
    async (signal) => {
      const worldId = newWorlds[index]!;
      await checked(() => controlClock(db, worldId, 'start'));
      await advance(worldId, TICKS_PER_MONTH, signal);
      await checked(() => controlClock(db, worldId, 'pause'));
      const archive = await checked(() => exportReplay(db, worldId));
      const hashes = replayArchive(archive, 1);
      expect(hashes).toHaveLength(1);
      monthHashes.push(hashes[0]!.stateHash);
      if (index === 1) expect(monthHashes[1]).toBe(monthHashes[0]);
      expect(await originalFootprint()).toBe(sourceFootprint);
    },
    120000,
  );
it('AC-M3-04 실패·중단된 준비도 원본과 다른 월드의 기록을 바꾸지 않는다', async (signal) => {
  const before = await fullFootprint(),
    aborted = new AbortController();
  aborted.abort();
  await expect(prepareWorldReset(db, oldWorlds[0]!, 'new', aborted.signal)).rejects.toThrow();
  await expect(prepareWorldReset(db, randomUUID(), 'new', signal)).rejects.toMatchObject({ code: 'WORLD_NOT_FOUND' });
  await expect(prepareWorldReset(db, oldWorlds[0]!, '\u0000', signal)).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  expect(await fullFootprint()).toBe(before);
  expect(await originalFootprint()).toBe(sourceFootprint);
});
afterAll(async () => {
  const deadline = Date.now() + 110000;
  let connections: number | undefined,
    dropped = false;
  const adminClosed = await cleanupWithReservedClose(
    async (signal) => {
      for (const c of controllers) if (c.signal !== signal) c.abort();
      await Promise.allSettled(children.map((child) => cleanupAttempt(child.stop)));
      await cleanupAttempt(settle, 50000, false);
      await Promise.allSettled(
        [() => app?.close(), () => gate.end(), () => db.$disconnect()].map((close) =>
          cleanupAttempt(async () => close()),
        ),
      );
      await cleanupAttempt(() => childScope.close());
      if (pending.size) fail(new Error('정착하지 않은 원 작업: DB 보존'));
      if (
        children.some((child) => !child.closed || !child.stdoutEnded || !child.stderrEnded) ||
        childScope.snapshot().state !== 'closed'
      )
        fail(new Error('실제 자식 close/streams 미확인: DB 보존'));
      for (const secret of secrets)
        if (secret && logs.join('\n').includes(secret)) fail(new Error('비공개 값 로그 노출'));
      if (oid) {
        ({ connections } = await checked(() => confirmDisconnectedDatabase(admin, name, oid!), signal));
        if (!failed && !errors.length && !pending.size && !signal.aborted && Date.now() + 30000 < deadline) {
          await dropExactOwnedDatabase(admin, name, oid, signal);
          expect(
            (await checked(() => admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name]), signal)).rows,
          ).toHaveLength(0);
          dropped = true;
        }
      }
    },
    () => admin.end(),
  );
  console.info(
    JSON.stringify({
      event: 'admin-reset-preparation-cleanup',
      name,
      oid,
      connections,
      dropped,
      adminClosed,
      childScopeState: childScope.snapshot().state,
      cliChildren: children.map(({ closed, stdoutEnded, stderrEnded }) => ({ closed, stdoutEnded, stderrEnded })),
      suiteFailed: failed,
      pendingOperations: pending.size,
      errors: errors.length,
    }),
  );
  if (errors.length) throw new AggregateError([...new Set(errors)], '초기화 준비 본문과 자기 자원 정리 실패');
}, 120000);
