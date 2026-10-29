import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createDb, type PrismaClient } from '../packages/db/src/index';
import { TICKS_PER_MONTH } from '../packages/rules/src/index';
import { adminResetPayloadSchema } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { controlClock } from '../apps/engine/src/world/clock';
import { readWorldState, saveInitialWorld } from '../apps/engine/src/world/persistence';
import { onShutdownRequest, stopOwnedChild } from '../apps/engine/src/process-lifecycle';
import { initializeResources } from './init-resources';
import { initializeIntegrationResources } from './integration-resources';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { requestWorldReset, getWorldResetRequest } from '../apps/server/src/admin/worldReset';
import { newSession } from '../apps/server/src/auth/session';
import type { Context } from '../apps/server/src/context';
import { exportReplay, replayToEnd } from '../apps/engine/src/replay';
import { checkedResetTarget } from '../apps/engine/src/admin/reset';
import {
  advanceWithLease,
  checkRehearsalArchiveTree,
  createRehearsalStages,
  readRehearsalArchive,
  RehearsalArchiveError,
  rehearsalStoragePath,
} from './t2-15-month-child';

// T2-15/AC-M2-09: 기존 전용 슬롯만 사용한다. 기본 DB·compose·운영 비밀 경로는 없다.
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : '/usr/bin/git';
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const environmentBefore = digest(JSON.stringify(Object.entries(process.env).sort()));
const controller = new AbortController();
const dbs = new Set<PrismaClient>();
const children = new Map<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>();
const evidence: Record<string, unknown> = {
  task: 'T2-15',
  ac: 'AC-M2-09',
  stages: [],
  children: [],
  cleanupErrors: [],
  stageBudgetMs: 20_000,
  limitations: [
    'PID/listener observations are endpoint samples, not a complete process history.',
    'Windows does not prove Linux POSIX permissions.',
  ],
};
type Inputs = {
  container: string;
  endpoint: string;
  system: string;
  role: string;
  admin: string;
  docker: string;
  host: string;
  store: string;
  workRoot: string;
  password: string;
  pnpm: string;
};
let input: Inputs | undefined;
let run = '',
  copy = '',
  work = '',
  lock = '',
  runId = '',
  backupDirectory = '';
let runCreated = false;
let cleanupPromise: Promise<void> | undefined;
let containerBefore: unknown;
let databasesBefore: { name: string; oid: string }[] | undefined;
let portsBefore: string | undefined;
let envFileBefore: unknown;
let worldId = '',
  sourceName = '',
  targetName = '',
  sourceOid = '',
  targetOid = '',
  archive = '',
  manifest = '';
let initialHash = '',
  targetAtB: unknown;
const B = 2 * TICKS_PER_MONTH;
let sourceCommit = '';
let resetSourceId = '',
  resetTargetId = '',
  resetUserId = '',
  resetSessionId = '',
  resetKey = '',
  resetPairBefore: unknown;

class RehearsalError extends Error {}
const fail = (reason: string): never => {
  throw new RehearsalError(reason);
};
const reasonOf = (error: unknown) => (error instanceof RehearsalError ? error.message : 'operation-failed');
const stages = createRehearsalStages(controller, (row) => (evidence.stages as unknown[]).push(row), { reasonOf });
const inside = (root: string, candidate: string) => {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
function settings(): Inputs {
  const get = (name: string) => {
    const value = process.env[`T215_${name}`] || fail(`missing-T215_${name}`);
    if (/[\0\r\n\u2028\u2029]/.test(value)) fail(`malformed-T215_${name}`);
    return value;
  };
  const values = {
    container: get('PG_CONTAINER'),
    endpoint: get('PG_ENDPOINT'),
    system: get('PG_SYSTEM_IDENTIFIER'),
    role: get('PG_ROLE'),
    admin: get('PG_ADMIN_DB'),
    docker: get('DOCKER'),
    host: get('DOCKER_HOST'),
    store: get('PNPM_STORE'),
    workRoot: get('WORK_ROOT'),
    password: get('PG_PASSWORD_FILE'),
    pnpm: process.env.npm_execpath ?? '',
  };
  if (!/^[0-9a-f]{64}$/.test(values.container) || !/^\d+$/.test(values.system)) fail('identity-input');
  const endpoint = /^127\.0\.0\.1:([0-9]{1,5})$/.exec(values.endpoint);
  if (!endpoint || Number(endpoint[1]) < 1 || Number(endpoint[1]) > 65535 || Number(endpoint[1]) === 5433)
    fail('dedicated-endpoint-required');
  if (![values.role, values.admin].every((v) => /^[a-z][a-z0-9_]{0,62}$/.test(v))) fail('role-or-admin-input');
  if (
    process.platform === 'win32'
      ? !/^npipe:\/\/\/\/\.\/pipe\/[^/\\]+$/.test(values.host)
      : !/^unix:\/\/\/.+/.test(values.host)
  )
    fail('local-daemon-required');
  if (![values.docker, values.password, values.store, values.workRoot, values.pnpm].every(isAbsolute))
    fail('absolute-input-required');
  if (!rehearsalStoragePath(values.workRoot) || !rehearsalStoragePath(values.store))
    fail('owned-storage-path-required');
  if (!/(?:^|[\\/])pnpm(?:\.cjs|[\\/]bin[\\/]pnpm\.cjs)$/.test(values.pnpm)) fail('pnpm-cli-input');
  return values;
}
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    TEMP: join(run, 'tmp'),
    TMP: join(run, 'tmp'),
    HOME: join(run, 'home'),
    USERPROFILE: join(run, 'home'),
  };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  else env.TMPDIR = join(run, 'tmp');
  return env;
}
function dockerEnv() {
  return { ...baseEnv(), DOCKER_HOST: input!.host, DOCKER_CONFIG: join(run, 'docker-config') };
}
function bashEnv() {
  return {
    ...dockerEnv(),
    PATH: process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin;C:/Program Files/Git/bin' : '/usr/bin:/bin',
  };
}
function pnpmEnv(databaseUrl?: string) {
  const home = join(run, 'home');
  const env: NodeJS.ProcessEnv = {
    ...baseEnv(),
    PATH:
      process.platform === 'win32'
        ? `${dirname(process.execPath)};${join(process.env.SystemRoot!, 'System32')}`
        : `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  if (process.platform === 'win32') env.ComSpec = process.env.ComSpec;
  for (const key of ['LOCALAPPDATA', 'APPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'])
    env[key] = join(home, key.toLowerCase());
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  return env;
}
function databaseUrl(name: string) {
  if (![sourceName, targetName].includes(name)) fail('unowned-database');
  const url = new URL(`postgresql://${input!.endpoint}/${name}`);
  url.username = input!.role;
  url.password = input!.password;
  return url.href;
}
async function command(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { stdin?: string; ipc?: boolean; cleanup?: boolean } = {},
): Promise<Buffer> {
  if (!options.cleanup) controller.signal.throwIfAborted();
  if (await exists(join(cwd, '.env'))) fail('child-cwd-has-env');
  const child = spawn(executable, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: options.ipc
      ? process.platform === 'win32'
        ? ['ignore', 'pipe', 'pipe', 'ipc']
        : ['ignore', 'pipe', 'pipe']
      : ['pipe', 'pipe', 'pipe'],
  });
  const record = {
    executable:
      executable === process.execPath
        ? 'node'
        : executable === input?.docker
          ? 'docker'
          : executable === bash
            ? 'bash'
            : executable === git
              ? 'git'
              : 'port-observation',
    pid: child.pid ?? null,
    code: null as number | null,
    signal: null as NodeJS.Signals | null,
  };
  (evidence.children as unknown[]).push(record);
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  child.stdout!.on('data', (data: Buffer) => stdout.push(data));
  child.stderr!.on('data', (data: Buffer) => stderr.push(data));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
    child.once('error', () => reject(new RehearsalError('child-spawn')));
    child.once('close', (code, signal) => {
      record.code = code;
      record.signal = signal;
      accept({ code, signal });
    });
  });
  children.set(child, exited);
  const abort = () => {
    void stopOwnedChild(child, exited).catch(() => {});
  };
  if (!options.cleanup) controller.signal.addEventListener('abort', abort, { once: true });
  child.stdin?.on('error', () => {});
  child.stdin?.end(options.stdin);
  try {
    const result = await exited;
    if (!options.cleanup) controller.signal.throwIfAborted();
    if (result.code !== 0) fail('child-nonzero');
    // 자식의 원문 출력은 메모리에서 판정하고 증거에 옮기지 않는다.
    if (
      options.ipc &&
      !/^(?:ok|lease-lost|aborted|failed)(?:\r?\n)?$/.test(
        Buffer.concat(stdout).toString('utf8') + Buffer.concat(stderr).toString('utf8'),
      )
    )
      fail('month-output-contract');
    return Buffer.concat(stdout);
  } finally {
    controller.signal.removeEventListener('abort', abort);
    children.delete(child);
  }
}
async function docker(args: string[], stdin?: string, cleanup = false) {
  return (await command(input!.docker, args, work, dockerEnv(), { ...(stdin === undefined ? {} : { stdin }), cleanup }))
    .toString('utf8')
    .trim();
}
async function catalog(sql: string, cleanup = false) {
  return docker(
    [
      'exec',
      '-i',
      input!.container,
      'psql',
      '-X',
      '-At',
      '-w',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      input!.role,
      '-d',
      input!.admin,
    ],
    sql,
    cleanup,
  );
}
async function identity(cleanup = false) {
  const raw: unknown = JSON.parse(
    await docker(['inspect', '--type', 'container', input!.container], undefined, cleanup),
  );
  assert.ok(Array.isArray(raw) && raw.length === 1, 'container-inspect');
  const item = raw[0] as {
    Id: string;
    State: { Running: boolean; StartedAt: string };
    RestartCount: number;
    Image: string;
    NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
  };
  if (
    item.Id !== input!.container ||
    !item.State.Running ||
    !item.NetworkSettings.Ports['5432/tcp']?.some((p) => `${p.HostIp}:${p.HostPort}` === input!.endpoint)
  )
    fail('container-binding-identity');
  if ((await catalog('SELECT system_identifier FROM pg_control_system();', cleanup)) !== input!.system)
    fail('cluster-identity-or-local-auth');
  return {
    id: item.Id,
    running: item.State.Running,
    startedAt: item.State.StartedAt,
    restartCount: item.RestartCount,
    image: item.Image,
  };
}
async function catalogList(cleanup = false): Promise<{ name: string; oid: string }[]> {
  return JSON.parse(
    await catalog(
      "SELECT coalesce(json_agg(t ORDER BY name)::text,'[]') FROM (SELECT datname AS name,oid::text AS oid FROM pg_database) t;",
      cleanup,
    ),
  ) as { name: string; oid: string }[];
}
async function ports(cleanup = false) {
  const executable =
    process.platform === 'win32' ? join(process.env.SystemRoot!, 'System32/NETSTAT.EXE') : '/usr/bin/ss';
  if (!(await exists(executable))) {
    evidence.portObservation = 'UNOBSERVED';
    return 'UNOBSERVED';
  }
  const text = (
    await command(executable, process.platform === 'win32' ? ['-ano', '-p', 'TCP'] : ['-ltnp'], work, baseEnv(), {
      cleanup,
    })
  ).toString('utf8');
  const selected = [5433, 5173, 3001, Number(input!.endpoint.split(':')[1])];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll(/\s+/g, ' '))
    .filter(
      (line) =>
        (process.platform !== 'win32' || line.includes(' LISTENING ')) &&
        selected.some((port) => new RegExp(`:${port}(?: |$)`).test(line)),
    )
    .sort()
    .join('\n');
}
async function envFile() {
  const path = join(checkout, '.env');
  if (!(await exists(path))) return { exists: false };
  return { exists: true, sha256: digest(await readFile(path)), mtime: (await stat(path)).mtimeMs };
}
function client(name: string) {
  controller.signal.throwIfAborted();
  const db = createDb(databaseUrl(name));
  dbs.add(db);
  return db;
}
async function disconnect(db: PrismaClient) {
  await db.$disconnect();
  dbs.delete(db);
}
async function canonical(db: PrismaClient) {
  const world = await db.world.findUniqueOrThrow({ where: { id: worldId }, select: { monthlyTick: true } });
  return {
    monthlyTick: world.monthlyTick,
    stateHash: hashState(await readWorldState(db, worldId)),
    snapshots: await db.yearbookSnapshot.findMany({
      where: { worldId },
      orderBy: { tick: 'asc' },
      select: { tick: true, stateHash: true },
    }),
    processedSequences: await db.inputEvent.findMany({
      where: { worldId, status: { not: 'PENDING' } },
      orderBy: { sequence: 'asc' },
      select: { sequence: true },
    }),
  };
}
async function atBoundary(db: PrismaClient) {
  const state = await canonical(db);
  assert.equal(state.monthlyTick, B);
  assert.equal(state.snapshots.filter((row) => row.tick === B).length, 1);
  assert.equal(state.snapshots.filter((row) => row.tick > B).length, 0);
  const [lease] = await db.$queryRaw<
    { expired: boolean }[]
  >`SELECT NOT EXISTS (SELECT 1 FROM "EngineLease" WHERE "worldId"=${worldId} AND "expiresAt">clock_timestamp() AT TIME ZONE 'UTC') AS expired`;
  assert.equal(lease?.expired, true);
  return state;
}
function resetContext(db: PrismaClient): Context {
  return { db, user: { id: resetUserId, email: 'reset-fixture@example.test' }, sessionId: resetSessionId } as Context;
}
async function resetPair(db: PrismaClient) {
  controller.signal.throwIfAborted();
  const source = await db.world.findUniqueOrThrow({ where: { id: resetSourceId } }),
    target = await db.world.findUniqueOrThrow({ where: { id: resetTargetId } }),
    event = await db.inputEvent.findUniqueOrThrow({
      where: {
        worldId_userId_idempotencyKey: { worldId: resetSourceId, userId: resetUserId, idempotencyKey: resetKey },
      },
    });
  controller.signal.throwIfAborted();
  checkedResetTarget(source, event, target);
  assert.equal(source.status, 'ENDED');
  assert.equal(target.status, 'PREOPEN');
  assert.equal(target.startedAt, null);
  assert.equal(target.clockTick, 0);
  assert.equal(await db.world.count(), 3);
  for (const id of [resetSourceId, resetTargetId]) {
    controller.signal.throwIfAborted();
    assert.equal(await db.nation.count({ where: { worldId: id } }), 21);
    assert.equal(await db.general.count({ where: { worldId: id, userId: null } }), 491);
    assert.equal(await db.general.count({ where: { worldId: id, userId: { not: null } } }), 0);
    assert.equal(await db.generalTurn.count({ where: { worldId: id } }), 491 * 30);
  }
  const query = await getWorldResetRequest(resetContext(db), {
    expectedUserId: resetUserId,
    worldId: resetSourceId,
    idempotencyKey: resetKey,
  });
  assert.equal(query.status, 'APPLIED');
  assert.equal(query.plannedNewWorldId, resetTargetId);
  const oldArchive = await exportReplay(db, resetSourceId),
    newArchive = await exportReplay(db, resetTargetId);
  assert.equal(replayToEnd(oldArchive).reason, 'ADMIN_RESET');
  assert.deepEqual(replayToEnd(JSON.parse(JSON.stringify(oldArchive))), replayToEnd(oldArchive));
  const audits = await db.auditLog.findMany({
    where: { worldId: resetSourceId, action: { in: ['world.reset.requested', 'world.reset.applied'] } },
    orderBy: { id: 'asc' },
  });
  assert.equal(audits.length, 2);
  assert.deepEqual(
    audits.map((row) => row.action),
    ['world.reset.requested', 'world.reset.applied'],
  );
  controller.signal.throwIfAborted();
  return JSON.parse(
    JSON.stringify({ source, target, event, audits, query, oldArchive, newArchive }, (_key, value) =>
      typeof value === 'bigint' ? String(value) : value,
    ),
  ) as unknown;
}
const stage = (name: string, action: () => Promise<void>) => stages.run(name, action);

// 모든 header와 추적 분모를 검증한 뒤 파일을 쓴다. 링크는 archive 안 regular 바이트로 채운다.
async function unpackTar(data: Buffer, lsTree: Buffer, head: string) {
  controller.signal.throwIfAborted();
  const plan = (() => {
    try {
      const result = readRehearsalArchive(data);
      checkRehearsalArchiveTree(lsTree, result);
      return result;
    } catch (error) {
      return fail(error instanceof RehearsalArchiveError ? error.message : 'archive-read');
    }
  })();
  for (const directory of plan.directories) {
    controller.signal.throwIfAborted();
    const destination = resolve(copy, directory);
    if (!inside(copy, destination)) fail('archive-path');
    await mkdir(destination, { recursive: true });
  }
  let filesWritten = 0;
  for (const file of plan.files) {
    controller.signal.throwIfAborted();
    const destination = resolve(copy, file.path);
    if (!inside(copy, destination)) fail('archive-path');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.data, { flag: 'wx', mode: 0o600 });
    filesWritten++;
  }
  const materializedLinks = [];
  for (const link of plan.links) {
    controller.signal.throwIfAborted();
    const expected = plan.files.find((file) => file.path === link.resolved && file.source === 'regular')!;
    const [linkBytes, targetBytes] = await Promise.all([
      readFile(resolve(copy, link.name)),
      readFile(resolve(copy, link.resolved)),
    ]);
    const targetSha256 = digest(expected.data);
    if (digest(linkBytes) !== targetSha256 || digest(targetBytes) !== targetSha256) fail('archive-materialize');
    materializedLinks.push({
      ...link,
      gitMode: '120000',
      materializedAs: 'regular',
      bytes: linkBytes.length,
      sha256: digest(linkBytes),
      targetSha256,
      readbackEqual: true,
    });
  }
  const regularFiles = plan.files.filter((file) => file.source === 'regular');
  evidence.archive = {
    source: head,
    tarSha256: digest(data),
    tarBytes: data.length,
    counts: { ...plan.counts, filesWritten },
    trackedTree: {
      blobs: plan.files.length,
      regularModes: plan.counts.regular,
      linkModes: plan.counts.link,
      equalToPlan: true,
      pathListSha256: digest(
        plan.files
          .map((file) => file.path)
          .sort()
          .join('\n'),
      ),
    },
    regularContentDigest: digest(
      regularFiles
        .map((file) => `${file.path}\0${digest(file.data)}\n`)
        .sort()
        .join(''),
    ),
    materializedLinks,
    fsLinksCreated: 0,
  };
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    controller.abort();
    const errors = evidence.cleanupErrors as unknown[];
    for (const [child, exited] of children) await stopOwnedChild(child, exited).catch(() => errors.push('child-stop'));
    await stages.settle();
    evidence.pendingStagesAfterCleanup = stages.activeCount;
    for (const db of dbs) await disconnect(db).catch(() => errors.push('db-disconnect'));
    if (input && databasesBefore) {
      for (const [name, oid] of [
        [targetName, targetOid],
        [sourceName, sourceOid],
      ] as const) {
        if (!oid) continue;
        try {
          await identity(true);
          const found = (await catalogList(true)).find((row) => row.name === name);
          if (!found) continue;
          if (
            found.oid !== oid ||
            !/^t215_(?:src|dst)_[0-9a-f]{32}_test$/.test(name) ||
            databasesBefore.some((row) => row.name === name)
          )
            fail('cleanup-identity');
          if ((await catalog(`SELECT count(*) FROM pg_stat_activity WHERE datname='${name}';`, true)) !== '0')
            fail('cleanup-connected');
          await catalog(`DROP DATABASE "${name}";`, true);
          evidence.dropped ??= [] as unknown[];
          (evidence.dropped as unknown[]).push({ name, oid, connectionsBeforeDrop: 0 });
        } catch {
          errors.push({ phase: 'database-drop', name, oid });
        }
      }
      try {
        const after = await catalogList(true);
        const assignedNames = [sourceName, targetName].filter(
          (name) => !databasesBefore!.some((row) => row.name === name),
        );
        const remainingOwned = after.filter((row) => assignedNames.includes(row.name));
        const others = after.filter((row) => !assignedNames.includes(row.name));
        evidence.remainingOwnedDatabases = remainingOwned;
        if (remainingOwned.length) errors.push({ phase: 'owned-database-retained', databases: remainingOwned });
        assert.deepEqual(others, databasesBefore);
        evidence.otherDatabases = {
          count: others.length,
          beforeSha256: digest(JSON.stringify(databasesBefore)),
          afterSha256: digest(JSON.stringify(others)),
          equal: true,
        };
        assert.deepEqual(await identity(true), containerBefore);
        evidence.containerPreserved = true;
        assert.equal(await ports(true), portsBefore);
        evidence.portPidsAndListenersPreserved = true;
        assert.deepEqual(await envFile(), envFileBefore);
        evidence.rootEnvPreserved = true;
      } catch {
        errors.push('final-preservation');
      }
    }
    evidence.parentEnvironmentPreserved =
      digest(JSON.stringify(Object.entries(process.env).sort())) === environmentBefore;
    evidence.connectionEndpoint = input?.endpoint ?? null;
    evidence.m1DatabaseConnectionPolicy = { forbidden: true, directlyMeasured: false };
    evidence.finishedUtc = new Date().toISOString();
    if (runCreated) {
      // 실제 경로와 runId가 맞는 자기 디렉터리만 정리한다.
      const actual = await realpath(run);
      if (
        !inside(await realpath(input!.workRoot), actual) ||
        dirname(actual) !== (await realpath(input!.workRoot)) ||
        !actual.endsWith(`t215-${runId}`)
      )
        fail('cleanup-directory-boundary');
      const evidenceDir = join(actual, 'evidence');
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(evidenceDir, 'receipt.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
      for (const entry of await readdir(actual))
        if (entry !== 'evidence') await rm(join(actual, entry), { recursive: true, force: true });
    }
    if (lock && (await exists(join(lock, 'runId'))) && (await readFile(join(lock, 'runId'), 'utf8')) === runId) {
      const resolvedLock = await realpath(lock);
      if (dirname(resolvedLock) !== (await realpath(input!.workRoot)) || !inside(input!.workRoot, resolvedLock))
        fail('cleanup-lock-boundary');
      await rm(resolvedLock, { recursive: true });
    }
    if (errors.length) fail('cleanup-incomplete');
  })();
  return cleanupPromise;
}
const off = onShutdownRequest(() => {
  controller.abort();
  void cleanup().catch(() => {});
});

describe('T2-15 B1 실제 복구 리허설', () => {
  beforeAll(async () => {
    try {
      await stage('inputs-and-slot', async () => {
        input = settings();
        for (const file of [bash, git, input.docker, input.password, input.pnpm])
          if (!(await stat(file)).isFile()) fail('required-executable-or-file');
        if (!(await stat(input.store)).isDirectory()) fail('offline-store-missing');
        if (!rehearsalStoragePath(await realpath(input.store))) fail('offline-store-boundary');
        const actualRoot = await realpath(input.workRoot);
        if (!rehearsalStoragePath(actualRoot) || actualRoot === checkout || inside(checkout, actualRoot))
          fail('work-root-boundary');
        input.workRoot = actualRoot;
        const password = (await readFile(input.password, 'utf8')).replace(/\r?\n$/, '');
        if (!password || /[\0\r\n]/.test(password)) fail('password-file-format');
        input.password = password;
        runId = randomUUID();
        sourceName = `t215_src_${randomUUID().replaceAll('-', '')}_test`;
        targetName = `t215_dst_${randomUUID().replaceAll('-', '')}_test`;
        evidence.plannedOwnedDatabaseNames = { source: sourceName, target: targetName };
        if ([sourceName, targetName].includes(input.admin)) fail('admin-is-owned-db');
        lock = join(input.workRoot, 't215.lock');
        await mkdir(lock);
        await writeFile(join(lock, 'runId'), runId, { flag: 'wx', mode: 0o600 });
        run = join(input.workRoot, `t215-${runId}`);
        await mkdir(run);
        runCreated = true;
        for (const directory of ['work', 'tmp', 'home', 'docker-config', 'backup dir', 'copy', 'evidence'])
          await mkdir(join(run, directory));
        work = join(run, 'work');
        copy = join(run, 'copy');
        backupDirectory = join(run, 'backup dir');
        containerBefore = await identity();
        databasesBefore = await catalogList();
        if (databasesBefore.some((row) => [sourceName, targetName].includes(row.name)))
          fail('new-database-already-exists');
        portsBefore = await ports();
        envFileBefore = await envFile();
        evidence.startedUtc = new Date().toISOString();
        evidence.containerBefore = containerBefore;
        evidence.otherDatabaseCount = databasesBefore.length;
        evidence.otherDatabaseBeforeSha256 = digest(JSON.stringify(databasesBefore));
      });
    } catch {
      /* case들이 동일한 미실행 사유로 실패하며 skip하지 않는다. */
    }
  });
  beforeAll(async () => {
    try {
      await stage('source-archive', async () => {
        const gitEnv = {
          ...baseEnv(),
          PATH:
            process.platform === 'win32'
              ? `${dirname(process.execPath)};${join(process.env.SystemRoot!, 'System32')}`
              : '/usr/bin:/bin',
        };
        const head = (await command(git, ['rev-parse', 'HEAD'], checkout, gitEnv)).toString('utf8').trim();
        if (!/^[a-f0-9]{40}$/.test(head)) fail('source-commit');
        if ((await command(git, ['status', '--porcelain', '--untracked-files=no'], checkout, gitEnv)).length)
          fail('source-has-tracked-edits');
        const tar = await command(git, ['archive', '--format=tar', head], checkout, gitEnv);
        const lsTree = await command(git, ['ls-tree', '-r', '-z', '--full-tree', head], checkout, gitEnv);
        await unpackTar(tar, lsTree, head);
        if (await exists(join(copy, '.env'))) fail('archive-has-env');
        evidence.source = head;
        sourceCommit = head;
      });
    } catch {
      /* 입력·준비 실패를 성공으로 바꾸지 않는다. */
    }
  });
  // 독립 작업마다 같은 20초 기한을 적용한다. 앞 단계 실패 시 뒤 단계도 실패한다.
  beforeAll(async () => {
    try {
      await stage('offline-install', async () => {
        await command(
          process.execPath,
          [input!.pnpm, 'install', '--offline', '--frozen-lockfile', '--store-dir', input!.store],
          copy,
          pnpmEnv(),
        );
      });
    } catch {
      /* 입력·준비 실패를 성공으로 바꾸지 않는다. */
    }
  });
  beforeAll(async () => {
    try {
      await stage('prisma-generate', async () => {
        await command(process.execPath, [input!.pnpm, '--filter', '@opensamguk/db', 'generate'], copy, pnpmEnv());
      });
    } catch {
      /* 입력·준비 실패를 성공으로 바꾸지 않는다. */
    }
  });
  it('1 원본 DB를 만들고 endpoint identity와 migration을 확인한다', () =>
    stage('source-create-migrate', async () => {
      await identity();
      await catalog(`CREATE DATABASE "${sourceName}" TEMPLATE template0;`);
      sourceOid = (await catalogList()).find((row) => row.name === sourceName)?.oid ?? fail('source-oid');
      evidence.sourceDatabase = { name: sourceName, oid: sourceOid };
      const db = client(sourceName);
      try {
        const [row] = await db.$queryRaw<
          { system: string }[]
        >`SELECT system_identifier::text AS system FROM pg_control_system()`;
        if (row?.system !== input!.system) fail('host-endpoint-identity');
      } finally {
        await disconnect(db);
      }
      await command(
        process.execPath,
        [input!.pnpm, '--filter', '@opensamguk/db', 'migrate'],
        copy,
        pnpmEnv(databaseUrl(sourceName)),
      );
      const migrated = client(sourceName);
      try {
        const names = (await readdir(join(copy, 'packages/db/prisma/migrations')))
          .filter((name) => /^\d{14}_/.test(name))
          .sort();
        const rows = await migrated.$queryRaw<
          { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
        >`SELECT migration_name,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
        assert.deepEqual(
          rows.map((row) => row.migration_name),
          names,
        );
        assert.ok(rows.every((row) => row.finished_at && !row.rolled_back_at));
        evidence.migrations = rows.length;
      } finally {
        await disconnect(migrated);
      }
    }));
  it('2 fixture를 1개월 진행하고 원본을 정지한다', () =>
    stage('source-fixture-T0', async () => {
      const db = client(sourceName);
      try {
        const initial = await monthlyFixture();
        controller.signal.throwIfAborted();
        worldId = (
          await saveInitialWorld(db, initial, {
            name: '백업 복구 시험',
            turnTermMinutes: 60,
            endYear: null,
            replayFormat: 'legacy',
          })
        ).worldId;
        controller.signal.throwIfAborted();
        await controlClock(db, worldId, 'start');
      } finally {
        await disconnect(db);
      }
      evidence.sourceLease = await advanceWithLease(
        databaseUrl(sourceName),
        worldId,
        TICKS_PER_MONTH,
        controller.signal,
      );
      const paused = client(sourceName);
      try {
        await controlClock(paused, worldId, 'pause');
        initialHash = hashState(await readWorldState(paused, worldId));
      } finally {
        await disconnect(paused);
      }
    }));
  it('2a 기존 월드를 보존하며 정식 초기화 원본과 실제 관리자 요청을 준비한다', () =>
    stage('reset-formal-admission', async () => {
      const db = client(sourceName);
      const failures: unknown[] = [];
      try {
        const existing = await canonical(db);
        await initializeResources(db, await readFile(join(copy, 'packages/db/sql/resources-init.sql'), 'utf8'));
        controller.signal.throwIfAborted();
        await initializeIntegrationResources(db);
        controller.signal.throwIfAborted();
        const initial = await loadInitialWorldFromDb(db, {
          scenario: 'integration191',
          map: 'integration',
          statRules: 'five-stats',
          portraitMap: '191-map',
          seed: 'reset-backup-source',
        });
        controller.signal.throwIfAborted();
        assert.equal(initial.nations.length, 21);
        assert.equal(initial.generals.length, 491);
        const ruleFeatures = [...new Set([...(initial.ruleFeatures ?? []), 'policy'])];
        resetSourceId = (
          await saveInitialWorld(
            db,
            { ...initial, ruleFeatures },
            { name: '초기화 백업 정식191', turnTermMinutes: 30, endYear: 200, ruleFeatures },
          )
        ).worldId;
        assert.equal(await db.generalTurn.count({ where: { worldId: resetSourceId } }), 491 * 30);
        await controlClock(db, resetSourceId, 'start');
        await controlClock(db, resetSourceId, 'pause');
        controller.signal.throwIfAborted();
        const user = await db.user.create({
          data: {
            email: 'reset-' + randomUUID() + '@example.test',
            passwordHash: 'isolated-unusable-fixture-hash',
            role: 'ADMIN',
          },
        });
        resetUserId = user.id;
        const session = newSession(Date.now());
        resetSessionId = session.id;
        resetKey = randomUUID();
        await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
        const source = await db.world.findUniqueOrThrow({ where: { id: resetSourceId } });
        const receipt = await requestWorldReset(resetContext(db), {
          expectedUserId: resetUserId,
          worldId: resetSourceId,
          idempotencyKey: resetKey,
          confirmName: source.name,
          expectedRevision: source.clockRevision,
          reason: '격리된 초기화 백업 검증',
          seed: 'reset-backup-target',
        });
        assert.equal(receipt.status, 'PENDING');
        resetTargetId = receipt.plannedNewWorldId;
        assert.equal(await db.world.count(), 2);
        assert.deepEqual(await canonical(db), existing);
        evidence.resetAdmission = {
          sourceWorldId: resetSourceId,
          targetWorldId: resetTargetId,
          pending: true,
          existingCanonicalPreserved: true,
          interface: 'actual API function with isolated DB session; not HTTP evidence',
        };
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await disconnect(db);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, '초기화 접수 고정물과 연결 정리 실패');
    }));
  it('2b fenced 엔진이 초기화 쌍을 원자 저장하고 원본 종료·새 PREOPEN을 확인한다', () =>
    stage('reset-formal-apply', async () => {
      const db = client(sourceName);
      const failures: unknown[] = [];
      try {
        const existing = await canonical(db);
        evidence.resetLease = await advanceWithLease(databaseUrl(sourceName), resetSourceId, 0, controller.signal);
        resetPairBefore = await resetPair(db);
        assert.deepEqual(await canonical(db), existing);
        const event = (resetPairBefore as { event: { payload: unknown } }).event;
        assert.equal(adminResetPayloadSchema.parse(event.payload).effectiveSeed, 'reset-backup-target');
        evidence.resetPairBefore = {
          worlds: 3,
          formalWorlds: 2,
          nationsEach: 21,
          npcEach: 491,
          humanEach: 0,
          slotsEach: 491 * 30,
          sourceWorldId: resetSourceId,
          targetWorldId: resetTargetId,
          sha256: hashState(resetPairBefore),
          oldEnded: true,
          newPreopen: true,
          existingCanonicalPreserved: true,
        };
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await disconnect(db);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, '초기화 백업 고정물과 리스 정리 실패');
    }));
  it('3 정지한 원본에서 실제 custom dump를 만든다', () =>
    stage('backup', async () => {
      await command(
        bash,
        [
          join(copy, 'tools/backup.sh'),
          '--docker',
          input!.docker,
          '--container',
          input!.container,
          '--system-identifier',
          input!.system,
          '--db-user',
          input!.role,
          '--admin-db',
          input!.admin,
          '--source-db',
          sourceName,
          '--backup-dir',
          backupDirectory,
          '--reason',
          'rehearsal',
          '--release-sha',
          sourceCommit,
        ],
        work,
        bashEnv(),
      );
      const files = await readdir(backupDirectory);
      const dumps = files.filter((name) => /^backup-.*\.dump$/.test(name)),
        manifests = files.filter((name) => /^backup-.*\.manifest\.json$/.test(name));
      assert.equal(dumps.length, 1);
      assert.equal(manifests.length, 1);
      archive = join(backupDirectory, dumps[0]!);
      manifest = join(backupDirectory, manifests[0]!);
      const receipt = JSON.parse(await readFile(manifest, 'utf8')) as {
        sha256: string;
        contentHash: string;
        releaseSha: string;
      };
      assert.equal(receipt.releaseSha, sourceCommit);
      assert.equal(digest(await readFile(archive)), receipt.sha256);
      evidence.archiveSha256 = receipt.sha256;
      evidence.restoredContentHash = receipt.contentHash;
    }));
  it('4 새 대상에 복원한 직후 내용과 상태 해시가 같다', () =>
    stage('restore', async () => {
      await identity();
      await command(
        bash,
        [
          join(copy, 'tools/restore.sh'),
          '--docker',
          input!.docker,
          '--container',
          input!.container,
          '--system-identifier',
          input!.system,
          '--db-user',
          input!.role,
          '--admin-db',
          input!.admin,
          '--archive',
          archive,
          '--manifest',
          manifest,
          '--target-db',
          targetName,
        ],
        work,
        bashEnv(),
      );
      targetOid = (await catalogList()).find((row) => row.name === targetName)?.oid ?? fail('target-oid');
      evidence.targetDatabase = { name: targetName, oid: targetOid };
      if (targetOid === sourceOid) fail('same-source-target-oid');
      const db = client(targetName);
      try {
        assert.equal(hashState(await readWorldState(db, worldId)), initialHash);
        assert.deepEqual(await resetPair(db), resetPairBefore);
        evidence.resetPairRestored = {
          equal: true,
          sha256: hashState(resetPairBefore),
          mappingAndOrigins: true,
          inputsAndAudits: true,
          nativeSingleTransactionRestore: true,
        };
        controller.signal.throwIfAborted();
        await controlClock(db, worldId, 'resume');
      } finally {
        await disconnect(db);
      }
    }));
  it('5 실제 month 자식이 정확히 B까지 진행하고 실행권을 푼다', () =>
    stage('month-child', async () => {
      const env: NodeJS.ProcessEnv = { ...baseEnv(), DATABASE_URL: databaseUrl(targetName) };
      for (const key of ['PUBLIC_MAP_DELAY_MINUTES', 'PUBLIC_MAP_INTERVAL_MINUTES'])
        if (process.env[key] !== undefined) env[key] = process.env[key];
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        await command(
          process.execPath,
          ['--import', 'tsx', join(copy, 'tools/t2-15-month-child.ts'), worldId, String(B)],
          copy,
          env,
          { ipc: true },
        );
      } finally {
        clearTimeout(timeout);
      }
      const db = client(targetName);
      try {
        targetAtB = await atBoundary(db);
      } finally {
        await disconnect(db);
      }
      evidence.monthChild = { boundary: B, normalExit: true, released: true };
    }));
  it('6 실제 내보내기·재생 CLI의 모든 월 해시가 같다', () =>
    stage('replay', async () => {
      const file = join(run, 'evidence', 'replay.json');
      await command(
        process.execPath,
        ['--import', 'tsx', join(copy, 'tools/replay.ts'), '--world', worldId, '--output', file],
        copy,
        { ...baseEnv(), DATABASE_URL: databaseUrl(targetName) },
      );
      await command(
        process.execPath,
        ['--import', 'tsx', join(copy, 'tools/replay.ts'), '--from', file, '--months', '2'],
        copy,
        baseEnv(),
      );
      evidence.replay = { months: 2, equal: true, sha256: digest(await readFile(file)) };
    }));
  it('7 원본을 같은 B까지 진행하면 canonical 값이 같다', () =>
    stage('source-B-compare', async () => {
      const sourceDb = client(sourceName);
      try {
        await controlClock(sourceDb, worldId, 'resume');
      } finally {
        await disconnect(sourceDb);
      }
      evidence.sourceBLease = await advanceWithLease(databaseUrl(sourceName), worldId, B, controller.signal);
      const db = client(sourceName);
      try {
        const state = await atBoundary(db);
        assert.deepEqual(state, targetAtB);
        assert.deepEqual(await resetPair(db), resetPairBefore);
        evidence.canonicalAtB = { equal: true, sha256: digest(JSON.stringify(state)) };
      } finally {
        await disconnect(db);
      }
    }));
  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      off();
    }
  });
});
