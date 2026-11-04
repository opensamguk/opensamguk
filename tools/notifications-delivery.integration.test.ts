import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, enqueueNotifications, type NotificationEntry } from '../packages/db/src/index';
import {
  dispatchNotificationBatch,
  startNotificationDispatcher,
  type DispatchOptions,
} from '../apps/server/src/notifications/dispatcher';
import { changeNotificationSettings } from '../apps/server/src/notifications/settings';
import { withdrawAccount } from '../apps/server/src/auth/withdrawalStore';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import { createSanction } from '../apps/server/src/admin/sanctionStore';
import { testDatabaseUrl } from './test-database';
import { listenLegalHttp } from '../e2e/legalFixturePorts';

type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(source.hostname) || source.search)
  throw Error('loopback 전용 시험 DB가 필요합니다.');
const database = `notification_delivery_${randomUUID().replaceAll('-', '')}_test`;
const targetUrl = new URL(source),
  adminUrl = new URL(source);
targetUrl.pathname = '/' + database;
adminUrl.pathname = '/postgres';
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Pg;
};
const admin = new Client({ connectionString: adminUrl.href }),
  sql = new Client({ connectionString: targetUrl.href });
const db = createDb(targetUrl.href);
const password = randomUUID(),
  publicOrigin = 'http://127.0.0.1:5173';
const releases: (() => void)[] = [],
  pending = new Set<Promise<unknown>>();
const children = new Set<ChildProcess>();
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.kill('SIGKILL');
  await ended;
}
function dispatchChild(phase: 'claimed' | 'observed' | 'run') {
  const child = fork(fileURLToPath(new URL('./fixtures/notification-dispatch-child.ts', import.meta.url)), [phase], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, TEST_DATABASE_URL: targetUrl.href, NOTIFICATION_FIXTURE_RECEIVER: receiverOrigin },
    silent: true,
    windowsHide: true,
  });
  children.add(child);
  const reached = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(Error('시험 IPC 전에 자식이 끝났습니다.')));
    child.on('message', (value: { stage?: string }) => {
      if (value.stage === (phase === 'run' ? 'done' : phase)) resolve();
    });
  });
  const ended = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  return { child, reached, ended };
}
let created = false,
  oid: unknown,
  worldId: string,
  passwordHash: string,
  receiverOrigin: string;
let hang = false;
let status = 204,
  drop = false,
  retryAfter = '2';
const received: Array<{ content: string; allowed_mentions: { parse: string[] } }> = [];
const receiver = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof received)[number]);
  if (hang) return;
  if (drop) {
    request.socket.destroy();
    return;
  }
  response.writeHead(status, { 'Retry-After': retryAfter, Location: receiverOrigin + '/must-not-follow' }).end();
});
function track<T>(promise: Promise<T>) {
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise),
  );
  return promise;
}
function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return {
    entered,
    release,
    hook: async () => {
      enter();
      await wait;
    },
  };
}
const pump = (options: Partial<DispatchOptions> = {}) =>
  track(
    dispatchNotificationBatch(db, {
      publicOrigin,
      transport: (_url, init) => fetch(receiverOrigin + '/trial', init),
      ...options,
    }),
  );
beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  oid = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [database])).rows[0]?.oid;
  await sql.connect();
  const directory = new URL('../packages/db/prisma/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => /^\d{14}_/.test(name)).sort())
    await sql.query(await readFile(new URL(name + '/migration.sql', directory), 'utf8'));
  passwordHash = await hashPassword(password);
  const world = await db.world.create({
    data: {
      name: '알림 시험',
      scenarioKey: 'notification-test',
      mapKey: 'notification-test',
      unitSetKey: 'notification-test',
      seed: 'notification-test',
      startYear: 191,
      turnTermMinutes: 60,
      initialStateHash: '0'.repeat(64),
      statRules: {},
      unitSet: {},
    },
  });
  worldId = world.id;
  await listenLegalHttp(receiver);
  receiverOrigin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  received.length = 0;
  hang = false;
  status = 204;
  drop = false;
  retryAfter = '2';
  await db.notificationOutbox.deleteMany();
  await db.notificationDispatchGate.update({ where: { id: 'discord' }, data: { blockedUntil: null } });
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const child of children) await stopChild(child);
  children.clear();
  while (pending.size) await Promise.allSettled([...pending]);
});
afterAll(async () => {
  for (const release of releases.splice(0)) release();
  for (const child of children) await stopChild(child);
  while (pending.size) await Promise.allSettled([...pending]);
  if (receiver.listening)
    await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
  await db.$disconnect();
  await sql.end();
  try {
    if (created) {
      expect((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [database])).rows).toEqual(
        [{ oid }],
      );
      expect(
        (await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [database])).rows,
      ).toEqual([{ count: 0 }]);
      await admin.query(`DROP DATABASE "${database}"`);
      expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [database])).rows).toEqual([]);
    }
  } finally {
    await admin.end();
  }
});
async function actor() {
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash } });
  const session = newSession(Date.now());
  await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
  const target = await db.notificationTarget.create({
    data: {
      userId: user.id,
      endpoint: 'https://discord.com/api/webhooks/100000000000000001/dispatcher-fake-token_ab12',
      last4: 'ab12',
      events: ['attacked'],
      verifiedAt: new Date(),
    },
  });
  return { id: user.id, sessionId: session.id, targetId: target.id };
}
function entry(userId: string, key = randomUUID()): NotificationEntry {
  return {
    worldId,
    userId,
    event: 'attacked',
    dedupeKey: `attacked:${worldId}:${userId}:${key}`,
    payload: { worldId, worldName: '알림 시험', year: 191, month: 1, text: '도시에서 전투가 벌어졌습니다.' },
  };
}
const enqueue = (value: NotificationEntry) => db.$transaction((tx) => enqueueNotifications(tx, [value]));
const last = (userId: string) =>
  db.notificationOutbox.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: 'desc' } });

it('같은 사건은 한 번 저장하고 게임 행을 바꾸지 않으며 실패 tx와 함께 롤백한다', async () => {
  const user = await actor(),
    value = entry(user.id),
    before = await db.world.findUnique({ where: { id: worldId } });
  expect(await enqueue(value)).toBe(1);
  expect(await enqueue(value)).toBe(0);
  expect(await db.notificationOutbox.count()).toBe(1);
  await expect(
    db.$transaction(async (tx) => {
      await enqueueNotifications(tx, [entry(user.id)]);
      throw Error('시험 롤백');
    }),
  ).rejects.toThrow('시험 롤백');
  expect(await db.notificationOutbox.count()).toBe(1);
  expect(await db.world.findUnique({ where: { id: worldId } })).toEqual(before);
});
it('대상이 없거나 꺼진 사건과 탈퇴 계정은 저장하지 않는다', async () => {
  const user = await actor();
  await db.notificationTarget.update({ where: { userId: user.id }, data: { events: [] } });
  expect(await enqueue(entry(user.id))).toBe(0);
  await db.notificationTarget.delete({ where: { userId: user.id } });
  expect(await enqueue(entry(user.id))).toBe(0);
  await db.user.update({ where: { id: user.id }, data: { status: 'WITHDRAWN' } });
  expect(await enqueue(entry(user.id))).toBe(0);
});
it('실제 HTTP 2xx를 한 번 관측해 SENT로 저장하고 다음 실행은 보내지 않는다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  expect((await pump()).claimed).toBe(1);
  expect((await last(user.id)).status).toBe('SENT');
  await pump();
  expect(received).toHaveLength(1);
  expect(received[0]).toEqual({
    content: `[오픈삼국] 알림 시험 191년 1월\n도시에서 전투가 벌어졌습니다.\n${publicOrigin}/w/${worldId}`,
    allowed_mentions: { parse: [] },
  });
});
it.each([
  '[지도](https://example.test/)',
  '<https://example.test/>',
  '//example.test/ user@example.test www.example.test',
])('이름·설명의 외부 링크 %s는 안전하게 출력하고 게임 payload는 보존한다', async (text) => {
  const user = await actor(),
    value = entry(user.id);
  value.payload.worldName = text;
  value.payload.text = text;
  await enqueue(value);
  await pump();
  const content = received[0]!.content;
  expect(content.match(/https?:\/\/[^\s]+/gu)).toEqual([publicOrigin + '/w/' + worldId]);
  expect(content).not.toContain('example.test');
  expect(content).not.toContain('//example');
  expect(content).not.toContain('[지도](');
  expect(content).not.toContain('<https://');
  if (text.startsWith('<')) expect(content).toContain('\\<https：');
  expect((await last(user.id)).payload).toEqual(value.payload);
  expect((await last(user.id)).status).toBe('SENT');
  expect(received).toHaveLength(1);
});
it.each([301, 400, 401, 404, 500])('관측 HTTP %i를 정책대로 저장하고 다시 보내지 않는다', async (value) => {
  const user = await actor();
  await enqueue(entry(user.id));
  status = value;
  await pump();
  await pump();
  expect(received).toHaveLength(1);
  expect((await last(user.id)).status).toBe(value === 500 ? 'UNKNOWN' : 'GAVE_UP');
  expect((await db.notificationTarget.findUniqueOrThrow({ where: { userId: user.id } })).status).toBe(
    [401, 404].includes(value) ? 'DISABLED' : 'ACTIVE',
  );
});
it('수신 뒤 응답 유실은 UNKNOWN이고 재전송하지 않는다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  drop = true;
  await pump();
  await pump();
  expect(received).toHaveLength(1);
  expect((await last(user.id)).status).toBe('UNKNOWN');
});
it('429는 행의 재시도 일정과 모든 새 집기의 지속형 공통 대기를 지킨다', async () => {
  const first = await actor(),
    second = await actor();
  await enqueue(entry(first.id));
  await enqueue(entry(second.id));
  status = 429;
  retryAfter = '120';
  const observedBefore = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const before = observedBefore[0]!.now.getTime();
  await pump();
  const row = await db.notificationOutbox.findFirstOrThrow({ where: { status: 'RETRY' } });
  expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
  expect(row.attempts).toBe(1);
  await pump();
  expect(received).toHaveLength(1);
  expect(
    (await db.notificationDispatchGate.findUniqueOrThrow({ where: { id: 'discord' } })).blockedUntil!.getTime(),
  ).toBeGreaterThanOrEqual(before + 120_000);
});
it('두 발송자가 경쟁해도 같은 건의 POST는 하나다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  const held = barrier(),
    first = pump({ afterClaim: held.hook });
  await held.entered;
  expect((await pump()).claimed).toBe(0);
  held.release();
  await first;
  expect(received).toHaveLength(1);
});
it('집은 뒤 해제·재등록의 새 대상은 옛 401로 꺼지지 않는다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  const held = barrier(),
    sending = pump({ afterClaim: held.hook });
  await held.entered;
  await changeNotificationSettings(db, { userId: user.id, sessionId: user.sessionId }, { generation: 0 });
  const target = await db.notificationTarget.create({
    data: {
      userId: user.id,
      endpoint: 'https://discord.com/api/webhooks/100000000000000001/dispatcher-fake-token_cd34',
      last4: 'cd34',
      events: ['attacked'],
      verifiedAt: new Date(),
    },
  });
  status = 401;
  held.release();
  await sending;
  expect((await db.notificationTarget.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('ACTIVE');
  expect(received).toHaveLength(1);
});
it('해제는 PENDING/RETRY를 같은 계정 tx에서 지워 재등록 뒤 되살리지 않는다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  await enqueue(entry(user.id));
  const row = await last(user.id);
  await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'RETRY', attempts: 1 } });
  await changeNotificationSettings(db, { userId: user.id, sessionId: user.sessionId }, { generation: 0 });
  expect(await db.notificationOutbox.count()).toBe(0);
  await pump();
  expect(received).toHaveLength(0);
});
it('실제 탈퇴 후 늦은 전송 결과는 대상을 만들거나 대기열을 복구하지 않는다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  const held = barrier(),
    sending = pump({ afterClaim: held.hook });
  await held.entered;
  await withdrawAccount(db, { userId: user.id, sessionId: user.sessionId, password, dummyPasswordHash: passwordHash });
  held.release();
  await sending;
  expect(received).toHaveLength(1);
  expect(await db.notificationOutbox.count()).toBe(0);
  expect(await db.notificationTarget.count({ where: { userId: user.id } })).toBe(0);
  expect(await enqueue(entry(user.id))).toBe(0);
});
it('실제 전역 제재와 종류 끄기는 집기 직전에 차단한다', async () => {
  const user = await actor(),
    operator = await actor();
  await db.user.update({ where: { id: operator.id }, data: { role: 'ADMIN' } });
  await enqueue(entry(user.id));
  await createSanction(
    db,
    operator.id,
    { userId: user.id, worldId: null, reason: '자기 발송 시험', expiresAt: null },
    Date.now(),
  );
  await pump();
  expect(received).toHaveLength(0);
  expect((await last(user.id)).status).toBe('GAVE_UP');
  const other = await actor();
  await enqueue(entry(other.id));
  await changeNotificationSettings(db, { userId: other.id, sessionId: other.sessionId }, { generation: 0, events: [] });
  await pump();
  expect(await db.notificationOutbox.count({ where: { userId: other.id } })).toBe(0);
  expect(received).toHaveLength(0);
});
it('2xx 후 기록 전 중단과 낡은 SENDING은 UNKNOWN으로만 회수한다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  await expect(
    pump({
      beforeResult: async () => {
        throw Error('기록 전 시험 중단');
      },
    }),
  ).rejects.toThrow('기록 전 시험 중단');
  expect(received).toHaveLength(1);
  expect((await last(user.id)).status).toBe('SENDING');
  await db.$executeRaw`UPDATE "NotificationOutbox" SET "claimedAt"=clock_timestamp()-interval '61 seconds' WHERE "userId"=${user.id}`;
  await pump();
  expect((await last(user.id)).status).toBe('UNKNOWN');
  expect(received).toHaveLength(1);
});
it('UNKNOWN 회수 뒤 늦은401은 같은 대상도 비활성화하지 않는다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  const held = barrier(),
    sending = pump({ beforeResult: held.hook });
  status = 401;
  await held.entered;
  await db.$executeRaw`UPDATE "NotificationOutbox" SET "claimedAt"=clock_timestamp()-interval '61 seconds' WHERE "userId"=${user.id}`;
  await pump();
  held.release();
  await sending;
  expect((await last(user.id)).status).toBe('UNKNOWN');
  expect((await db.notificationTarget.findUniqueOrThrow({ where: { userId: user.id } })).status).toBe('ACTIVE');
});
it('종료 요청은 현재 집기만 마치고 다음 건은 집지 않는다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  await enqueue(entry(user.id));
  const held = barrier();
  const worker = startNotificationDispatcher(
    db,
    { publicOrigin, transport: (_url, init) => fetch(receiverOrigin + '/trial', init), afterClaim: held.hook },
    () => {
      throw Error('시험 발송 작업 실패');
    },
  );
  await held.entered;
  const stopping = worker.stop();
  held.release();
  await stopping;
  expect(received).toHaveLength(1);
  expect(await db.notificationOutbox.count({ where: { status: 'PENDING' } })).toBe(1);
});

it('실제 응답 대기가 10초를 넘으면 한 요청만 UNKNOWN이며 가린 건수만 알린다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  hang = true;
  const summaries: Array<{ unknown: number }> = [],
    started = performance.now();
  await pump({ onSummary: (value) => summaries.push(value) });
  expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
  await pump();
  expect(received).toHaveLength(1);
  expect((await last(user.id)).status).toBe('UNKNOWN');
  expect(summaries).toEqual([{ unknown: 1 }]);
});
it('실제 1분이 지나기 전 SENDING을 집지 않고 지난 뒤에도 재전송하지 않는다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  await expect(
    pump({
      afterClaim: async () => {
        throw Error('집기 후 시험 중단');
      },
    }),
  ).rejects.toThrow('집기 후 시험 중단');
  await pump();
  expect((await last(user.id)).status).toBe('SENDING');
  expect(received).toHaveLength(0);
  await delay(61_000);
  await pump();
  expect((await last(user.id)).status).toBe('UNKNOWN');
  expect(received).toHaveLength(0);
}, 75_000);
it('429의 실제 공통 기한 뒤 다른 대상은 진행하고 원래 행의 1분 일정은 유지한다', async () => {
  const user = await actor(),
    other = await actor();
  await enqueue(entry(user.id));
  await enqueue(entry(other.id));
  status = 429;
  retryAfter = '2';
  await pump();
  const retry = await db.notificationOutbox.findFirstOrThrow({ where: { status: 'RETRY' } });
  status = 204;
  await pump();
  expect(received).toHaveLength(1);
  await delay(2200);
  await pump();
  expect(received).toHaveLength(2);
  expect((await db.notificationOutbox.findUniqueOrThrow({ where: { id: retry.id } })).status).toBe('RETRY');
  expect(await db.notificationOutbox.count({ where: { status: 'SENT' } })).toBe(1);
});
it('429는 정확한 1·5·15분 일정을 저장하고 네 번째 시도 뒤 포기한다', async () => {
  const user = await actor();
  await enqueue(entry(user.id));
  status = 429;
  retryAfter = '0';
  for (const [index, seconds] of [60, 300, 900, 900].entries()) {
    const observed = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    await pump();
    const row = await last(user.id);
    expect(row.attempts).toBe(index + 1);
    expect(row.status).toBe(index === 3 ? 'GAVE_UP' : 'RETRY');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(observed[0]!.now.getTime() + seconds * 1000);
    // 실제 15분 경과 증거가 아니라 저장 일정·다음 조건부 집기의 검증이다.
    if (index < 3)
      await db.$executeRaw`UPDATE "NotificationOutbox" SET "nextAttemptAt"=clock_timestamp()-interval '1 second' WHERE id=${row.id}`;
  }
  await pump();
  expect(received).toHaveLength(4);
});
it('탈퇴 행 잠금 뒤 기다린 enqueue는 비활성 계정의 대기열을 다시 만들지 않는다', async () => {
  const user = await actor(),
    held = barrier();
  const changing = track(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${user.id} FOR UPDATE`;
      await tx.user.update({ where: { id: user.id }, data: { status: 'WITHDRAWN' } });
      await tx.notificationTarget.delete({ where: { userId: user.id } });
      await held.hook();
    }),
  );
  await held.entered;
  const writing = track(enqueue(entry(user.id)));
  await expect
    .poll(async () =>
      Number(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%FOR SHARE%'",
            [database],
          )
        ).rows[0]!.count,
      ),
    )
    .toBe(1);
  held.release();
  await changing;
  expect(await writing).toBe(0);
  expect(await db.notificationOutbox.count()).toBe(0);
});
it.each(['claimed', 'observed'] as const)(
  '실제 자식을 %s에서 SIGKILL하고 새 프로세스로 다시 읽어도 보내지 않는다',
  async (phase) => {
    const user = await actor();
    await enqueue(entry(user.id));
    const running = dispatchChild(phase);
    await running.reached;
    expect((await last(user.id)).status).toBe('SENDING');
    expect(received).toHaveLength(phase === 'observed' ? 1 : 0);
    await stopChild(running.child);
    await running.ended;
    await db.$executeRaw`UPDATE "NotificationOutbox" SET "claimedAt"=clock_timestamp()-interval '61 seconds' WHERE "userId"=${user.id}`;
    const restarted = dispatchChild('run');
    await restarted.reached;
    expect(await restarted.ended).toBe(0);
    expect((await last(user.id)).status).toBe('UNKNOWN');
    expect(received).toHaveLength(phase === 'observed' ? 1 : 0);
  },
);
it.each(['attempts', 'generation', 'event', 'payload', 'claim'] as const)(
  '실제 DB는 잘못된 %s 상태를 거부한다',
  async (field) => {
    const user = await actor();
    await enqueue(entry(user.id));
    const row = await last(user.id);
    const data =
      field === 'attempts'
        ? { attempts: 5 }
        : field === 'generation'
          ? { generation: -1 }
          : field === 'event'
            ? { event: 'unknown' }
            : field === 'payload'
              ? { payload: {} }
              : { status: 'SENDING' as const };
    await expect(db.notificationOutbox.update({ where: { id: row.id }, data })).rejects.toThrow();
    expect(await db.notificationOutbox.findUnique({ where: { id: row.id } })).toEqual(row);
  },
);
