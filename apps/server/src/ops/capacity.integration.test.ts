import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, statfs } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Socket } from 'node:net';
import { createDb } from '@opensamguk/db';
import fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it as test, type TestContext } from 'vitest';
import { CAPACITY_REPEAT_MS, CapacityMonitorConfig, evaluateDiskCapacity, readDatabaseCapacity } from './capacity';
import { createCapacityMonitor, type CapacityMonitorDependencies } from './monitor';

// AC-M3-09 M1: own PG/read-only data, native statfs, and injected loopback delivery only.
// No real 80/90 quota fixture, Discord acceptance, user disk fill or operating-world action.
type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'end', listener: () => void): void;
};
const requireDb = createRequire(new URL('../../../../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string; connectionTimeoutMillis: number; query_timeout: number }) => Pg;
};
function testUrl(): URL {
  try {
    const value = new URL(process.env.TEST_DATABASE_URL ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(value.protocol) ||
      !['127.0.0.1', 'localhost'].includes(value.hostname) ||
      !/^\/[a-z][a-z0-9_]*_test$/.test(value.pathname) ||
      [...value.searchParams.keys()].some((key) =>
        ['host', 'hostaddr', 'port', 'dbname', 'database', 'service', 'options'].includes(key.toLowerCase()),
      )
    )
      throw new Error();
    return value;
  } catch {
    throw new Error('M1 loopback 전용 시험 DB 설정이 필요합니다.');
  }
}
const base = testUrl();
const name = 'm1_capacity_' + randomUUID().replaceAll('-', '') + '_test';
const target = new URL(base);
target.pathname = '/' + name;
const adminUrl = new URL(base);
adminUrl.pathname = '/postgres';
const client = (url: URL) =>
  new Client({ connectionString: url.href, connectionTimeoutMillis: 1500, query_timeout: 2000 });
const admin = client(adminUrl);
const native = client(target);
const db = createDb(target.href);
const WEBHOOK = 'https://discord.com/api/webhooks/123456789/capacity_fixture';
const signals = new AsyncLocalStorage<AbortSignal>();
const controllers = new Set<AbortController>();
const pending = new Set<Promise<unknown>>();
const errors: Error[] = [];
// Preserve native causes in memory without sending URL/credentials/raw errors to Vitest/stdout.
const causes = new WeakMap<Error, unknown>();
let failed = false;
let uncertain = false;
let creationAttempted = false;
let creationConfirmed = false;
let baselineAbsent = false;
let oid: string | undefined;
let root: string | undefined;
let rootReal: string | undefined;
let baselineRows: string | undefined;
let setupStarted = false;
let setupCompleted = false;
let cleanupDeadline = Infinity;
let primaryClosed = false;
let nativeClosed = false;
let adminClosed = false;
let nativeConnected = false;
let adminConnected = false;
let nativeEnded = false;
let adminEnded = false;
function failure(label: string, cause?: unknown) {
  const error = new Error('M1 시험 ' + label + ' 실패');
  causes.set(error, cause);
  failed = true;
  errors.push(error);
  for (const controller of controllers) controller.abort();
  return error;
}
admin.on('error', (error) => failure('관리 연결 비동기 오류', error));
native.on('error', (error) => failure('native 연결 비동기 오류', error));
admin.on('end', () => {
  adminEnded = true;
});
native.on('end', () => {
  nativeEnded = true;
});
function track<T>(label: string, work: () => PromiseLike<T>, retainFailure = true): Promise<T> {
  const original = Promise.resolve().then(work);
  const operation = original.catch((cause: unknown) => {
    if (retainFailure) throw failure(label, cause);
    const error = new Error('M1 시험 ' + label + ' 거부');
    causes.set(error, cause);
    throw error;
  });
  pending.add(operation);
  void operation.then(
    () => pending.delete(operation),
    () => pending.delete(operation),
  );
  return operation;
}
async function bounded<T>(
  label: string,
  work: () => PromiseLike<T>,
  ms = 4000,
  options: { signal?: AbortSignal; reserve?: number; retainFailure?: boolean } = {},
): Promise<T> {
  const signal = options.signal ?? signals.getStore();
  signal?.throwIfAborted();
  const available = Math.min(ms, cleanupDeadline - Date.now() - (options.reserve ?? 3000));
  if (available <= 0) throw failure(label + ' 정착 예산');
  const operation = track(
    label,
    () => {
      signal?.throwIfAborted();
      return work();
    },
    options.retainFailure ?? true,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          uncertain = true;
          for (const controller of controllers) controller.abort();
          reject(failure(label + ' 기한: 자기 DB 보존'));
        }, available);
      }),
    ]);
    signal?.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
  }
}
async function settle(ms: number) {
  const end = Date.now() + ms;
  while (pending.size) {
    const remaining = Math.min(end, cleanupDeadline - 3000) - Date.now();
    if (remaining <= 0) {
      uncertain = true;
      throw failure('미정착 작업: 자기 DB 보존');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            uncertain = true;
            reject(failure('작업 정착 기한: 자기 DB 보존'));
          }, remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
async function runSetup(work: () => Promise<void>, budget = 24_000) {
  const controller = new AbortController();
  controllers.add(controller);
  setupStarted = true;
  // beforeAll has no TestContext.signal. Finish within the unchanged30sec hook;
  // retain the actual body after timeout and abort it before cleanup can proceed.
  const original = track('준비 원본문', () =>
    signals.run(controller.signal, async () => {
      controller.signal.throwIfAborted();
      await work();
      controller.signal.throwIfAborted();
    }),
  );
  void original.finally(() => controllers.delete(controller)).catch(() => {});
  try {
    await bounded('전체 준비', () => original, budget, { signal: controller.signal });
    setupCompleted = true;
  } catch (error) {
    controller.abort();
    throw failure('전체 준비 중단: 자기 DB 보존', error);
  }
}
function it(title: string, work: (signal: AbortSignal) => Promise<void>) {
  test(title, (context: TestContext) => {
    const controller = new AbortController();
    controllers.add(controller);
    const signal = AbortSignal.any([context.signal, controller.signal]);
    context.onTestFailed(() => {
      failure('runner 실패: 자기 DB 보존');
      controller.abort();
    });
    const original = track(title, () => signals.run(signal, () => work(signal)));
    void original.finally(() => controllers.delete(controller)).catch(() => {});
    return original;
  });
}
beforeEach(async () => {
  await settle(5000);
  if (failed || uncertain || pending.size) throw failure('이전 실패 뒤 새 시험 거부');
});

async function footprint() {
  const rows = await bounded('보존 행 조회', () => native.query('SELECT id,label FROM "M1Sentinel" ORDER BY id'));
  const sequence = await bounded('보존 sequence 조회', () =>
    native.query('SELECT last_value,is_called FROM "M1Sentinel_id_seq"'),
  );
  const tables = await bounded('자기 표 목록', () =>
    native.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"),
  );
  return createHash('sha256')
    .update(JSON.stringify([rows.rows, sequence.rows, tables.rows]))
    .digest('hex');
}
function ownRoot() {
  if (!root || !rootReal) throw failure('자기 임시 폴더 없음');
  return root;
}
function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolvePromise = yes;
  });
  return { promise, resolve: resolvePromise };
}
type Receiver = {
  server: Server;
  sockets: Set<Socket>;
  bodies: string[];
  address: string;
  hold: boolean;
  status: number;
  received: ReturnType<typeof deferred<void>>;
  responseClosed: ReturnType<typeof deferred<void>>;
  closed: boolean;
  close?: Promise<void>;
};
const receivers: Receiver[] = [];
const monitors: Array<ReturnType<typeof createCapacityMonitor>> = [];
const apps: Array<ReturnType<typeof fastify>> = [];
async function receiver(): Promise<Receiver> {
  const server = createServer();
  const selected: Receiver = {
    server,
    sockets: new Set(),
    bodies: [],
    address: '',
    hold: false,
    status: 204,
    received: deferred<void>(),
    responseClosed: deferred<void>(),
    closed: false,
  };
  receivers.push(selected);
  server.requestTimeout = 4000;
  server.on('connection', (socket) => {
    selected.sockets.add(socket);
    socket.once('close', () => selected.sockets.delete(socket));
  });
  server.on('request', (request, response) => {
    const body = track('자기 HTTP 수신', async () => {
      let text = '';
      for await (const chunk of request) {
        text += String(chunk);
        if (text.length > 16384) throw new Error('시험 수신 크기 초과');
      }
      const input = JSON.parse(text) as { content?: unknown };
      if (request.method !== 'POST' || request.url !== '/receipt' || typeof input.content !== 'string')
        throw new Error('시험 수신 형식 오류');
      selected.bodies.push(input.content);
      response.once('close', () => selected.responseClosed.resolve());
      selected.received.resolve();
      if (!selected.hold) response.writeHead(selected.status).end();
    });
    void body.catch(() => response.destroy());
  });
  await bounded('자기 HTTP bind', async () => {
    for (let attempt = 0; attempt < 16; attempt++) {
      try {
        await new Promise<void>((yes, no) => {
          const cleanup = () => {
            server.off('error', failed);
            server.off('listening', listening);
          };
          const failed = (error: Error) => {
            cleanup();
            no(error);
          };
          const listening = () => {
            cleanup();
            yes();
          };
          server.once('error', failed);
          server.once('listening', listening);
          try {
            server.listen(randomInt(20_000, 50_000), '127.0.0.1');
          } catch (error) {
            cleanup();
            no(error);
          }
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('자기 주소 없음');
        selected.address = 'http://127.0.0.1:' + address.port + '/receipt';
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || server.listening) throw error;
      }
    }
    throw new Error('자기 HTTP bind 소진');
  });
  return selected;
}
function closeReceiver(selected: Receiver) {
  return (selected.close ??= bounded('자기 HTTP close', async () => {
    const sockets = [...selected.sockets];
    const socketClosed = sockets.map((socket) => new Promise<void>((yes) => socket.once('close', () => yes())));
    const serverClosed = new Promise<void>((yes, no) => {
      selected.server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') no(error);
        else yes();
      });
    });
    for (const socket of sockets) socket.destroy();
    const settled = await Promise.allSettled([serverClosed, ...socketClosed]);
    const rejected = settled.filter((result) => result.status === 'rejected');
    if (rejected.length)
      throw new AggregateError(
        rejected.map((result) => result.reason),
        '자기 HTTP close 정착 실패',
      );
    if (selected.server.listening || selected.sockets.size) throw new Error('자기 HTTP 미정착');
    selected.closed = true;
  }));
}
function delivery(selected: Receiver, signal: AbortSignal) {
  return async (webhook: string, content: string, monitorSignal: AbortSignal) => {
    expect(webhook === WEBHOOK, '시험 전용 설정만 전달').toBe(true);
    return track('실제 loopback 전송', async () => {
      try {
        const response = await fetch(selected.address, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
          signal: AbortSignal.any([signal, monitorSignal, AbortSignal.timeout(3000)]),
        });
        await response.body?.cancel();
        return response.status >= 200 && response.status < 300;
      } catch (error) {
        if (monitorSignal.aborted || signal.aborted) return false;
        throw error;
      }
    });
  };
}
function monitor(config: CapacityMonitorConfig, dependencies: CapacityMonitorDependencies) {
  const selected = createCapacityMonitor(config, dependencies);
  monitors.push(selected);
  return selected;
}
afterEach(async () => {
  const results = await Promise.allSettled([
    ...monitors.map((selected) => bounded('monitor 정지', () => selected.stop(), 6000)),
    ...apps.map((app) => bounded('자기 Fastify close', () => app.close(), 6000)),
  ]);
  for (const result of results) if (result.status === 'rejected') failure('본문 뒤 독립 정리', result.reason);
  const closed = await Promise.allSettled(receivers.map(closeReceiver));
  for (const result of closed) if (result.status === 'rejected') failure('수신기 독립 정리', result.reason);
  await settle(5000);
  if (failed || uncertain) throw new AggregateError(errors, 'M1 본문·정리 실패 보존');
});

beforeAll(() =>
  runSetup(async () => {
    await bounded(
      '관리 연결',
      async () => {
        await admin.connect();
        adminConnected = true;
      },
      2000,
    );
    const before = await bounded('생성 전 정확 이름', () =>
      admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name]),
    );
    expect(before.rows).toHaveLength(0);
    baselineAbsent = true;
    creationAttempted = true;
    await bounded('자기 DB CREATE', () => admin.query('CREATE DATABASE "' + name + '"'));
    creationConfirmed = true;
    const created = await bounded('생성 OID', () =>
      admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name]),
    );
    if (created.rows.length !== 1 || !/^[1-9]\d*$/.test(String(created.rows[0]!.oid))) throw failure('생성 OID');
    oid = String(created.rows[0]!.oid);
    await bounded('자기 DB SQL 한도', () => admin.query('ALTER DATABASE "' + name + '" SET statement_timeout=2000'));
    await bounded(
      '자기 DB 연결',
      async () => {
        await native.connect();
        nativeConnected = true;
      },
      2000,
    );
    await bounded('자기 보존 자료', () =>
      native.query(
        'CREATE TABLE "M1Sentinel"(id serial PRIMARY KEY,label text NOT NULL); INSERT INTO "M1Sentinel"(label) VALUES (\'unchanged\')',
      ),
    );
    baselineRows = await footprint();
    await bounded('자기 DB 읽기 전용 기본', () =>
      admin.query('ALTER DATABASE "' + name + '" SET default_transaction_read_only=on'),
    );
    await bounded('기존 자기 연결 읽기 전용', () => native.query('SET default_transaction_read_only=on'));
    await bounded('자기 임시 폴더', async () => {
      root = await mkdtemp(join(tmpdir(), 'opensamguk-m1-capacity-'));
      signals.getStore()?.throwIfAborted();
      rootReal = await realpath(root);
    });
  }),
);

it('AC-M3-09 M1 실제 현재 DB 용량은 읽기 전용이며 자기 기존 행·sequence를 보존한다', async () => {
  const identity = await bounded(
    '실제 DB 신원',
    () =>
      db.$queryRaw<
        Array<{ name: string; readonly: string }>
      >`SELECT current_database() AS name,current_setting('transaction_read_only') AS readonly`,
  );
  expect(identity).toEqual([{ name, readonly: 'on' }]);
  const actual = await bounded('실제 readDatabaseCapacity', () => readDatabaseCapacity(db));
  const reference = await bounded('native 현재 DB 용량', () =>
    native.query('SELECT current_database() AS name,pg_database_size(current_database())::text AS bytes'),
  );
  expect(reference.rows[0]!.name === name, '자기 DB만 조회').toBe(true);
  expect(actual > 0n, '실제 양수 DB 크기').toBe(true);
  expect(actual).toBe(BigInt(String(reference.rows[0]!.bytes)));
  const denied = await bounded('실제 읽기 전용 거부', async () => {
    try {
      await native.query('INSERT INTO "M1Sentinel"(label) VALUES (\'forbidden\')');
      return '';
    } catch (error) {
      return (error as { code?: string }).code;
    }
  });
  expect(denied).toBe('25006');
  expect(await footprint()).toBe(baselineRows);
});
it('AC-M3-09 M1 자기 임시 경로의 native statfs만 실제로 읽는다', async () => {
  const selected = ownRoot();
  const before = await bounded('자기 native statfs', () => statfs(selected, { bigint: true }));
  expect(before.blocks > 0n && before.bsize > 0n && before.bavail >= 0n).toBe(true);
  const sample = evaluateDiskCapacity(before);
  expect(sample.totalBytes).toBe((before.blocks * before.bsize).toString());
  expect(sample.bytes).toBe(((before.blocks - before.bavail) * before.bsize).toString());
  expect(['healthy', 'warning', 'critical']).toContain(sample.level);
  expect((await realpath(selected)) === rootReal, '자기 임시 경로 일치').toBe(true);
  expect(await footprint()).toBe(baselineRows);
});
it('AC-M3-09 M1 실제 경로 오류와 DB 경고를 격리하고 loopback 수신·중복·반복을 확인한다', async (signal) => {
  const selected = await receiver();
  const missing = join(ownRoot(), 'absent-path-canary');
  let now = 0;
  let failures = 0;
  const observed = monitor(new CapacityMonitorConfig([missing], 1n, WEBHOOK), {
    readDisk: (path) => statfs(path, { bigint: true }),
    readDatabase: () => readDatabaseCapacity(db),
    notify: delivery(selected, signal),
    failure: () => failures++,
    now: () => now,
  });
  await bounded('실제 경로·DB poll', () => observed.poll());
  expect(selected.bodies).toHaveLength(2);
  expect(selected.bodies.some((body) => body.includes('대상 disk-1\n상태 조회 실패'))).toBe(true);
  expect(selected.bodies.some((body) => body.includes('대상 database\n상태 경고'))).toBe(true);
  const messages = selected.bodies.join('\n');
  for (const secret of [missing, target.href, WEBHOOK, 'ENOENT', 'absent-path-canary'])
    expect(messages.includes(secret), '알림은 경로·접속·원문을 노출하지 않는다').toBe(false);
  expect(failures).toBe(1);
  now = CAPACITY_REPEAT_MS - 1;
  await bounded('중복 억제 poll', () => observed.poll());
  expect(selected.bodies).toHaveLength(2);
  now++;
  await bounded('반복 경계 poll', () => observed.poll());
  expect(selected.bodies).toHaveLength(4);
  expect(await footprint()).toBe(baselineRows);
});
it('AC-M3-09 M1 실제 DB 조회 거부 뒤 회복 전달 실패는 재시도하고 성공 회복은 한 번이다', async (signal) => {
  const selected = await receiver();
  let now = 0;
  let failRead = true;
  let failures = 0;
  const observed = monitor(new CapacityMonitorConfig([ownRoot()], 10n ** 30n, WEBHOOK), {
    readDisk: (path) => statfs(path, { bigint: true }),
    readDatabase: async () => {
      if (failRead) await db.$queryRaw`SELECT 1/0`;
      return readDatabaseCapacity(db);
    },
    notify: delivery(selected, signal),
    failure: () => failures++,
    now: () => now,
  });
  const databaseMessages = () => selected.bodies.filter((body) => body.includes('대상 database\n'));
  await bounded('실제 DB 오류 poll', () => observed.poll());
  expect(databaseMessages()).toHaveLength(1);
  expect(databaseMessages()[0]!.includes('조회 실패')).toBe(true);
  expect(selected.bodies.join('\n').includes('division by zero')).toBe(false);
  failRead = false;
  selected.status = 503;
  await bounded('실제 회복 수신 거부', () => observed.poll());
  expect(databaseMessages()).toHaveLength(2);
  expect(databaseMessages()[1]!.includes('회복')).toBe(true);
  selected.status = 204;
  await bounded('회복 실패 중복 억제', () => observed.poll());
  expect(databaseMessages()).toHaveLength(2);
  now += CAPACITY_REPEAT_MS;
  await bounded('회복 실제 재전달', () => observed.poll());
  await bounded('성공 회복 중복 없음', () => observed.poll());
  expect(databaseMessages()).toHaveLength(3);
  expect(failures).toBeGreaterThanOrEqual(2);
  expect(await footprint()).toBe(baselineRows);
});
it('AC-M3-09 M1 실제 수신 대기 중 서버 close는 전송 취소와 실제 정착을 기다린다', async (signal) => {
  const selected = await receiver();
  selected.hold = true;
  const missing = join(ownRoot(), 'pending-path');
  let notifySettled = false;
  let notifySignal: AbortSignal | undefined;
  const send = delivery(selected, signal);
  const observed = monitor(new CapacityMonitorConfig([missing], 10n ** 30n, WEBHOOK), {
    readDisk: (path) => statfs(path, { bigint: true }),
    readDatabase: () => readDatabaseCapacity(db),
    notify: async (webhook, content, pendingSignal) => {
      notifySignal = pendingSignal;
      try {
        return await send(webhook, content, pendingSignal);
      } finally {
        notifySettled = true;
      }
    },
    failure: () => {},
    now: () => 0,
  });
  const app = fastify();
  apps.push(app);
  app.addHook('onReady', async () => observed.start());
  app.addHook('preClose', async () => observed.stop());
  await bounded('자기 서버 ready', () => app.ready());
  await bounded('실제 pending 수신', () => selected.received.promise);
  expect(notifySettled).toBe(false);
  expect(notifySignal?.aborted).toBe(false);
  await bounded('실제 서버 close', () => app.close(), 6000);
  expect(notifySignal?.aborted).toBe(true);
  expect(notifySettled).toBe(true);
  await bounded('실제 수신 응답 close', () => selected.responseClosed.promise);
  const count = selected.bodies.length;
  await bounded('닫힌 monitor 재조회', () => observed.poll());
  expect(selected.bodies).toHaveLength(count);
  expect(await footprint()).toBe(baselineRows);
});

// eslint-disable-next-line no-empty-pattern -- Vitest suite fixtures require an empty context before suite.
afterAll(async ({}, suite) => {
  if (suite.result?.state === 'fail') failure('runner suite 실패: 자기 DB 보존');
  if (!setupStarted || !setupCompleted) failure('준비 미완료: 자기 DB 보존');
  cleanupDeadline = Date.now() + 27_000;
  for (const controller of controllers) controller.abort();
  const attempt = async (label: string, work: () => PromiseLike<unknown>, ms = 3000) => {
    try {
      await bounded(label, work, ms);
      return true;
    } catch (error) {
      failure(label, error);
      return false;
    }
  };
  await Promise.allSettled([
    ...monitors.map((selected) => attempt('최종 monitor close', () => selected.stop(), 5000)),
    ...apps.map((app) => attempt('최종 Fastify close', () => app.close(), 5000)),
  ]);
  await Promise.allSettled(receivers.map((selected) => attempt('최종 수신기 close', () => closeReceiver(selected))));
  try {
    await settle(5000);
  } catch (error) {
    failure('최종 작업 정착', error);
  }
  await Promise.allSettled([
    attempt('Prisma disconnect', async () => {
      await db.$disconnect();
      primaryClosed = true;
    }),
    attempt('native end', async () => {
      await native.end();
      if (nativeConnected && !nativeEnded) throw new Error('native actual end 미확인');
      nativeClosed = true;
    }),
    attempt('setup admin end', async () => {
      await admin.end();
      if (adminConnected && !adminEnded) throw new Error('admin actual end 미확인');
      adminClosed = true;
    }),
  ]);
  const audit = client(adminUrl);
  let auditClosed = false;
  let auditConnected = false;
  let auditEnded = false;
  audit.on('error', (error) => failure('독립 audit 비동기 오류', error));
  audit.on('end', () => {
    auditEnded = true;
  });
  let connections: number | undefined;
  let observedOid: string | undefined;
  let dropped = false;
  let catalogAbsent = false;
  let rootRemoved = false;
  try {
    await bounded(
      '독립 최종 관리 연결',
      async () => {
        await audit.connect();
        auditConnected = true;
      },
      2000,
    );
    if (creationAttempted && baselineAbsent) {
      const rows = await bounded(
        'CREATE 불명 포함 정확 이름 감사',
        () => audit.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name]),
        2000,
      );
      if (rows.rows.length > 1) throw failure('중복 DB 이름');
      observedOid = rows.rows[0] ? String(rows.rows[0].oid) : undefined;
      const activity = await bounded(
        '자기 DB 실제 연결 수',
        () => audit.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name]),
        2000,
      );
      connections = Number(activity.rows[0]!.count);
      if (connections !== 0 || (oid && observedOid !== oid) || (!oid && observedOid)) uncertain = true;
      if (
        !failed &&
        !uncertain &&
        pending.size === 0 &&
        creationConfirmed &&
        oid &&
        observedOid === oid &&
        connections === 0 &&
        primaryClosed &&
        nativeClosed &&
        adminClosed &&
        receivers.every((r) => r.closed)
      ) {
        const beforeDrop = await bounded(
          'DROP 직전 OID 재검사',
          () =>
            audit.query(
              'SELECT oid::text AS oid,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=$1) AS connections FROM pg_database WHERE datname=$1',
              [name],
            ),
          2000,
        );
        if (
          beforeDrop.rows.length !== 1 ||
          String(beforeDrop.rows[0]!.oid) !== oid ||
          Number(beforeDrop.rows[0]!.connections) !== 0
        )
          throw failure('DROP 신원 변경');
        await bounded('정상 자기 DB DROP', () => audit.query('DROP DATABASE "' + name + '"'), 2000);
        dropped = true;
        catalogAbsent =
          (
            await bounded(
              'DROP catalog 부재',
              () => audit.query('SELECT oid FROM pg_database WHERE datname=$1', [name]),
              2000,
            )
          ).rows.length === 0;
        if (!catalogAbsent) throw failure('DROP catalog 잔류');
      }
    }
    if (!failed && !uncertain && pending.size === 0 && dropped && root && rootReal) {
      const actual = await bounded('자기 폴더 실제 경계', () => realpath(root!));
      const parent = await bounded('자기 임시 상위 경계', () => realpath(tmpdir()));
      if (
        actual !== rootReal ||
        dirname(actual) !== parent ||
        !resolve(actual).startsWith(join(parent, 'opensamguk-m1-capacity-'))
      )
        throw failure('폴더 경계');
      await bounded('자기 폴더 삭제', () => rm(actual, { recursive: true, maxRetries: 3, retryDelay: 50 }));
      rootRemoved = true;
    }
  } catch (error) {
    failure('최종 DB·폴더 감사', error);
  } finally {
    try {
      await bounded('독립 audit actual end', () => audit.end(), 3000, { reserve: 0 });
      if (auditConnected && !auditEnded) failure('audit actual end 미확인');
      else auditClosed = true;
    } catch (error) {
      failure('audit close', error);
    }
  }
  console.log(
    JSON.stringify({
      event: 'capacity-m1-cleanup',
      name,
      oid: oid ?? null,
      observedOid: observedOid ?? null,
      setupStarted,
      setupCompleted,
      creationAttempted,
      creationConfirmed,
      connections: connections ?? null,
      dropped,
      catalogAbsent,
      primaryClosed,
      nativeClosed,
      adminClosed,
      auditClosed,
      nativeConnected,
      adminConnected,
      auditConnected,
      nativeEnded,
      adminEnded,
      auditEnded,
      receivers: receivers.map((r) => ({ listening: r.server.listening, sockets: r.sockets.size, closed: r.closed })),
      pendingOperations: pending.size,
      uncertain,
      suiteFailed: failed,
      rootRemoved,
      rootPreserved: Boolean(root && !rootRemoved),
      errors: errors.length,
      actualExternalDiscord: false,
      actualQuota80or90: false,
    }),
  );
  if (errors.length || failed || uncertain || !auditClosed || pending.size)
    throw new AggregateError(errors, 'M1 실제 시험·자기 자원 정리 실패: DB 보존');
});
