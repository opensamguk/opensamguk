import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { inferRouterOutputs } from '@trpc/server';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import type { AppRouter } from '../apps/server/src/router';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { authzCase } from '../apps/server/src/authz/case';
import { createSanction, liftSanction } from '../apps/server/src/admin/sanctionStore';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error('전용 테스트 DB가 필요합니다.');
const target = new URL(url);
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(target.pathname) ||
  target.searchParams.has('host') ||
  target.searchParams.has('port')
)
  throw Error('loopback 전용 테스트 DB를 확인하세요.');
const db = createDb(url),
  userIds: string[] = [],
  logs: string[] = [];
const token = 'notification-fake-token_ab12';
const webhook = `https://discord.com/api/webhooks/100000000000000001/${token}`;
const otherWebhook = `${webhook}CD34`;
const routes = [
  'notification.get',
  'notification.setDiscord',
  'notification.setEvents',
  'notification.removeDiscord',
] as const;
type Route = (typeof routes)[number];
type Data = inferRouterOutputs<AppRouter>['notification']['get'];
type Actor = { id: string; cookie: string; sessionId: string };
let app: Awaited<ReturnType<typeof buildServer>>, base: string, receiverBase: string, passwordHash: string;
const password = randomUUID();
type Received = { path: string; body: { content: string; allowed_mentions: { parse: string[] } } };
let received: Received[] = [],
  status = 204,
  drop = false;
let hold: { entered: () => void; wait: Promise<void> } | undefined;
const pending: Promise<unknown>[] = [];
let release: (() => void) | undefined;
const receiver = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  received.push({ path: request.url!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Received['body'] });
  const gate = hold;
  hold = undefined;
  if (gate) {
    gate.entered();
    await gate.wait;
  }
  if (drop) {
    request.socket.destroy();
    return;
  }
  response.writeHead(status, { 'Retry-After': '2', Location: `${receiverBase}/must-not-follow` });
  response.end(status === 204 ? undefined : 'private-discord-response');
});
async function actor(options: { verified?: boolean; consented?: boolean } = {}) {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({
    data: {
      id,
      email: `${id}@example.invalid`,
      passwordHash,
      emailVerifiedAt: options.verified === false ? null : new Date(),
      consents: {
        create:
          options.consented === false
            ? []
            : [
                { docType: 'TERMS', version: 'notification-terms-test' },
                { docType: 'PRIVACY', version: 'notification-privacy-test' },
              ],
      },
    },
  });
  const session = newSession(Date.now());
  await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
  return { id, cookie: `sid=${session.token}`, sessionId: session.id };
}
function input(route: Route) {
  if (route === 'notification.get') return undefined;
  if (route === 'notification.setDiscord') return { url: webhook, events: ['attacked'], generation: 0 };
  if (route === 'notification.setEvents') return { events: [], generation: 0 };
  return { generation: 0 };
}
async function rpc(route: Route | 'account.withdraw', value: unknown, user?: Actor) {
  const mutation = route !== 'notification.get',
    encoded = JSON.stringify({ 0: value });
  const response = await fetch(
    `${base}/trpc/${route}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin: 'http://127.0.0.1:5173',
        ...(user ? { cookie: user.cookie } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  type Envelope = { result?: { data: Data }; error?: { message: string; data: { code: string } } };
  const json = (await response.json()) as Envelope | Envelope[];
  const body = Array.isArray(json) ? json[0]! : json;
  return {
    status: response.status,
    data: body.result?.data,
    error: body.error,
    text: JSON.stringify(body),
    retryAfter: response.headers.get('Retry-After'),
  };
}
async function seed(user: Actor, disabled = false) {
  return db.notificationTarget.create({
    data: {
      userId: user.id,
      endpoint: webhook,
      last4: 'ab12',
      events: ['attacked'],
      verifiedAt: new Date(),
      ...(disabled ? { status: 'DISABLED', disabledReason: 'DISCORD_GONE' } : {}),
    },
  });
}
async function snapshot(user: Actor) {
  return {
    user: await db.user.findUnique({ where: { id: user.id }, select: { notificationGeneration: true } }),
    target: await db.notificationTarget.findUnique({ where: { userId: user.id } }),
  };
}
async function delayedRegistration(user: Actor) {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  hold = { entered, wait };
  const result = rpc('notification.setDiscord', input('notification.setDiscord'), user);
  pending.push(result);
  await waiting;
  return { result };
}
beforeAll(async () => {
  passwordHash = await hashPassword(password);
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  if (!address || typeof address === 'string') throw Error('가짜 수신기 포트를 확인하세요.');
  receiverBase = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  received = [];
  logs.length = 0;
  status = 204;
  drop = false;
  hold = undefined;
  release = undefined;
  app = await buildServer({
    db,
    logging: true,
    emailVerificationRequired: true,
    legalPolicy: {
      terms: { version: 'notification-terms-test', effectiveAt: '2026-01-01T00:00:00Z', bodyText: '자기 시험 약관' },
      privacy: {
        version: 'notification-privacy-test',
        effectiveAt: '2026-01-01T00:00:00Z',
        bodyText: '자기 시험 탈퇴 보존 기준',
      },
    },
    withdrawalPolicy: { scheme: 'tombstone-v1', privacyVersion: 'notification-privacy-test' },
    logStream: new Writable({
      write(chunk, _encoding, callback) {
        logs.push(String(chunk));
        callback();
      },
    }),
    notificationTransport: (endpoint, options) => fetch(`${receiverBase}${new URL(endpoint).pathname}`, options),
  });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  release?.();
  await Promise.allSettled(pending.splice(0));
  await app.close();
  expect(logs.join('')).not.toContain(token);
  expect(logs.join('')).not.toContain('private-discord-response');
});
afterAll(async () => {
  receiver.closeAllConnections();
  await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
  await db.notificationTarget.deleteMany({ where: { userId: { in: userIds } } });
  await db.sanction.deleteMany({ where: { userId: { in: userIds } } });
  await db.session.deleteMany({ where: { userId: { in: userIds } } });
  await db.heritageEntry.deleteMany({ where: { userId: { in: userIds } } });
  await db.heritageAccount.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});
for (const route of routes) {
  it(
    `${route}: 정상`,
    authzCase(route, 'success', async () => {
      const user = await actor();
      if (route === 'notification.setEvents') await seed(user);
      const result = await rpc(route, input(route), user);
      expect(result.status).toBe(200);
      expect(result.data!.generation).toBe(route === 'notification.get' ? 0 : 1);
      expect(result.text).not.toContain(token);
      expect(result.text).not.toContain('endpoint');
    }),
  );
  it(
    `${route}: 무인증`,
    authzCase(route, 'unauthenticated', async () => {
      expect((await rpc(route, input(route))).error?.data.code).toBe('UNAUTHORIZED');
      expect(received).toHaveLength(0);
    }),
  );
  it(
    `${route}: 다른 계정 주입 거부`,
    authzCase(route, 'otherUser', async () => {
      const owner = await actor(),
        outsider = await actor();
      await seed(owner);
      const before = await snapshot(owner);
      expect((await rpc(route, { ...input(route), userId: owner.id }, outsider)).error?.data.code).toBe('BAD_REQUEST');
      expect(await snapshot(owner)).toEqual(before);
      expect((await rpc('notification.get', undefined, outsider)).data?.discord).toBeNull();
      expect(received).toHaveLength(0);
    }),
  );
  it(
    `${route}: 제재`,
    authzCase(route, 'sanctioned', async () => {
      const user = await actor();
      const admin = await actor();
      await db.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
      await createSanction(
        db,
        admin.id,
        { userId: user.id, worldId: null, reason: '자기 시험 제재', expiresAt: null },
        Date.now(),
      );
      expect((await rpc(route, input(route), user)).error?.data.code).toBe('UNAUTHORIZED');
      expect((await snapshot(user)).user?.notificationGeneration).toBe(0);
      expect(received).toHaveLength(0);
    }),
  );
  it(
    `${route}: 잘못된 입력`,
    authzCase(route, 'invalidInput', async () => {
      const user = await actor();
      expect(
        (await rpc(route, { ...input(route), generation: -1, targetId: randomUUID() }, user)).error?.data.code,
      ).toBe('BAD_REQUEST');
      expect((await snapshot(user)).user?.notificationGeneration).toBe(0);
      expect(received).toHaveLength(0);
    }),
  );
}
it('등록·해제·새 대상 재등록에도 세대가 유지되고 비밀은 공개하지 않는다', async () => {
  const user = await actor();
  const first = await rpc(
    'notification.setDiscord',
    { url: webhook, events: ['turns.low', 'attacked'], generation: 0 },
    user,
  );
  expect(first.data?.discord?.events).toEqual(['attacked', 'turns.low']);
  expect(first.data?.discord?.last4).toBe('ab12');
  expect(first.data?.eventOptions.map((option) => option.name)).toEqual([
    '예턴 실패',
    '공격받음',
    '외교 제안',
    '예턴 3칸 이하',
  ]);
  const firstId = (await snapshot(user)).target!.id;
  expect(received[0]?.body).toEqual({
    content: '[오픈삼국] 디스코드 알림 연결을 확인했습니다.',
    allowed_mentions: { parse: [] },
  });
  expect((await rpc('notification.removeDiscord', { generation: 1 }, user)).data).toMatchObject({
    discord: null,
    generation: 2,
  });
  const next = await rpc('notification.setDiscord', { url: otherWebhook, events: [], generation: 2 }, user);
  expect(next.data).toMatchObject({ discord: { last4: 'CD34', events: [] }, generation: 3 });
  expect((await snapshot(user)).target!.id).not.toBe(firstId);
  expect((await rpc('notification.get', undefined, user)).data).toEqual(next.data);
  expect(received).toHaveLength(2);
});
it.each([
  ['attacked', 'attacked'],
  ['unknown'],
  ['attacked', 'turn.failed', 'turns.low', 'diplomacy.offer', 'attacked'],
])('잘못된 종류 %j는 POST 전에 거부한다', async (...events) => {
  const user = await actor();
  expect((await rpc('notification.setDiscord', { url: webhook, events, generation: 0 }, user)).error?.data.code).toBe(
    'BAD_REQUEST',
  );
  expect(received).toHaveLength(0);
});
it('다른 주소는 고정 오류이며 POST와 저장이 없다', async () => {
  const user = await actor();
  const result = await rpc(
    'notification.setDiscord',
    { url: `https://example.invalid/${token}`, events: [], generation: 0 },
    user,
  );
  expect(result.error).toMatchObject({ message: '디스코드 웹훅 주소가 아닙니다.', data: { code: 'BAD_REQUEST' } });
  expect(result.text).not.toContain(token);
  expect(received).toHaveLength(0);
  expect((await snapshot(user)).target).toBeNull();
});
it.each([401, 404, 429, 302, 400, 500])('시험 응답 %i는 자동 재전송·설정 변경이 없다', async (code) => {
  const user = await actor();
  await seed(user);
  status = code;
  const before = await snapshot(user);
  const result = await rpc('notification.setDiscord', input('notification.setDiscord'), user);
  expect(result.error?.data.code).toBe('PRECONDITION_FAILED');
  expect(result.text).not.toContain(token);
  expect(result.text).not.toContain('private-discord-response');
  expect(received).toHaveLength(1);
  expect(await snapshot(user)).toEqual(before);
});
it('본문 수신 뒤 응답 연결을 잃으면 재전송·저장이 없다', async () => {
  const user = await actor();
  drop = true;
  const result = await rpc('notification.setDiscord', input('notification.setDiscord'), user);
  expect(result.error?.message).toBe('디스코드가 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.');
  expect(received).toHaveLength(1);
  expect((await snapshot(user)).target).toBeNull();
});
it('대상 없는 종류 저장은 거부하고 비활성 대상은 다시 활성화하지 않는다', async () => {
  const user = await actor();
  expect((await rpc('notification.setEvents', { events: [], generation: 0 }, user)).error?.data.code).toBe(
    'PRECONDITION_FAILED',
  );
  await seed(user, true);
  expect((await rpc('notification.setEvents', { events: [], generation: 0 }, user)).data).toMatchObject({
    generation: 1,
    discord: { status: 'disabled', disabledReason: 'DISCORD_GONE', events: [] },
  });
  expect(received).toHaveLength(0);
});
it('해제·새 등록 뒤 늦은 옛 등록은 세대를 되돌리지 않는다', async () => {
  const user = await actor(),
    delayed = await delayedRegistration(user);
  expect((await rpc('notification.removeDiscord', { generation: 0 }, user)).data?.generation).toBe(1);
  expect(
    (await rpc('notification.setDiscord', { url: otherWebhook, events: [], generation: 1 }, user)).data?.generation,
  ).toBe(2);
  const before = await snapshot(user);
  release!();
  expect((await delayed.result).error?.data.code).toBe('CONFLICT');
  expect(await snapshot(user)).toEqual(before);
  expect(received).toHaveLength(2);
});
it('시험 중 종류 변경 뒤 늦은 등록은 기존 설정을 덮지 않는다', async () => {
  const user = await actor();
  await seed(user);
  const delayed = await delayedRegistration(user);
  expect((await rpc('notification.setEvents', { events: [], generation: 0 }, user)).data?.generation).toBe(1);
  const before = await snapshot(user);
  release!();
  expect((await delayed.result).error?.data.code).toBe('CONFLICT');
  expect(await snapshot(user)).toEqual(before);
});
it.each(['ended', 'expired', 'sanction-lifted'] as const)(
  '시험 중 세션 %s 뒤 늦은 성공은 저장하지 않는다',
  async (mode) => {
    const user = await actor();
    const delayed = await delayedRegistration(user);
    if (mode === 'expired')
      await db.session.update({ where: { id: user.sessionId }, data: { expiresAt: new Date(0) } });
    else if (mode === 'sanction-lifted') {
      const admin = await actor();
      await db.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
      const sanction = await createSanction(
        db,
        admin.id,
        {
          userId: user.id,
          worldId: null,
          reason: '자기 시험 제재',
          expiresAt: null,
        },
        Date.now(),
      );
      await liftSanction(db, admin.id, { sanctionId: sanction.sanctionId, reason: '자기 시험 해제' }, Date.now());
      expect(await db.session.findUnique({ where: { id: user.sessionId } })).toBeNull();
    } else await db.session.delete({ where: { id: user.sessionId } });
    const before = await snapshot(user);
    release!();
    expect((await delayed.result).error?.data.code).toBe('UNAUTHORIZED');
    expect(await snapshot(user)).toEqual(before);
    expect(received).toHaveLength(1);
  },
);
it('동시 등록은 둘 중 하나만 저장한다', async () => {
  const user = await actor(),
    delayed = await delayedRegistration(user);
  expect(
    (await rpc('notification.setDiscord', { url: otherWebhook, events: [], generation: 0 }, user)).data?.generation,
  ).toBe(1);
  const before = await snapshot(user);
  release!();
  expect((await delayed.result).error?.data.code).toBe('CONFLICT');
  expect(await snapshot(user)).toEqual(before);
});
it('탈퇴 트랜잭션이 대상을 지우며 늦은 시험 결과가 복원하지 않는다', async () => {
  const user = await actor();
  await seed(user);
  const delayed = await delayedRegistration(user);
  expect((await rpc('account.withdraw', { expectedUserId: user.id, password }, user)).status).toBe(200);
  const before = await snapshot(user);
  expect(before.target).toBeNull();
  release!();
  expect((await delayed.result).error?.data.code).toBe('UNAUTHORIZED');
  expect(await snapshot(user)).toEqual(before);
});
it('현재 세션 잠금 대기 중 삭제되면 POST 전에 거부한다', async () => {
  const user = await actor();
  let locked!: () => void;
  const entered = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${user.sessionId} FOR UPDATE`;
    locked();
    await wait;
    await tx.session.delete({ where: { id: user.sessionId } });
  });
  pending.push(blocker);
  await entered;
  const result = rpc('notification.setDiscord', input('notification.setDiscord'), user);
  pending.push(result);
  let waiting = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM "Session"%FOR UPDATE'`;
    if (Number(rows[0]?.count) > 0) {
      waiting = true;
      break;
    }
    await delay(5);
  }
  expect(waiting).toBe(true);
  release!();
  await blocker;
  expect((await result).error?.data.code).toBe('UNAUTHORIZED');
  expect((await snapshot(user)).target).toBeNull();
  expect((await snapshot(user)).user?.notificationGeneration).toBe(0);
  expect(received).toHaveLength(0);
});
it('세대 정수 상한에서는 넘치거나 POST하지 않는다', async () => {
  const user = await actor();
  await db.user.update({ where: { id: user.id }, data: { notificationGeneration: 2147483647 } });
  expect(
    (await rpc('notification.setDiscord', { url: webhook, events: [], generation: 2147483647 }, user)).error?.data.code,
  ).toBe('CONFLICT');
  expect((await snapshot(user)).user?.notificationGeneration).toBe(2147483647);
  expect(received).toHaveLength(0);
});
it('알 수 없는 키에 들어간 주소도 오류나 로그에 싣지 않는다', async () => {
  const user = await actor();
  const result = await rpc(
    'notification.setDiscord',
    { ...input('notification.setDiscord'), [webhook]: 'unexpected' },
    user,
  );
  expect(result.error?.data.code).toBe('BAD_REQUEST');
  expect(result.text).not.toContain(token);
  expect(received).toHaveLength(0);
});
it('등록 시도 제한 뒤에는 POST와 저장이 없고 Retry-After를 반환한다', async () => {
  const user = await actor();
  for (let attempt = 0; attempt < 5; attempt++)
    expect(
      (await rpc('notification.setDiscord', { url: 'invalid', events: [], generation: 0 }, user)).error?.data.code,
    ).toBe('BAD_REQUEST');
  const result = await rpc('notification.setDiscord', input('notification.setDiscord'), user);
  expect(result.error?.data.code).toBe('TOO_MANY_REQUESTS');
  expect(Number(result.retryAfter)).toBeGreaterThan(0);
  expect((await snapshot(user)).target).toBeNull();
  expect(received).toHaveLength(0);
});
for (const route of ['notification.setDiscord', 'notification.setEvents', 'notification.removeDiscord'] as const) {
  it.each(['email', 'consent'] as const)(`${route}: %s 확인 전에는 조회만 허용한다`, async (missing) => {
    const user = await actor({ verified: missing !== 'email', consented: missing !== 'consent' });
    await seed(user);
    const before = await snapshot(user);
    expect((await rpc('notification.get', undefined, user)).status).toBe(200);
    const result = await rpc(route, input(route), user);
    expect(result.error?.data.code).toBe('FORBIDDEN');
    expect(await snapshot(user)).toEqual(before);
    expect(received).toHaveLength(0);
  });
}
