import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { createDb, notifyWorld } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { buildServer } from '../apps/server/src/server';
import { appRouter } from '../apps/server/src/router';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { issueAccountToken } from '../apps/server/src/auth/accountTokenStore';
import { hashToken, newSession } from '../apps/server/src/auth/session';
import { hashPassword, verifyPassword } from '../apps/server/src/auth/password';
import { createMailTransport } from '../apps/server/src/mail/transport';
import type { MailTransport } from '../apps/server/src/mail/transport';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const origin = 'http://127.0.0.1:5173';
const paths = [
  'account.get',
  'account.resendVerification',
  'account.verifyEmail',
  'account.requestPasswordReset',
  'account.resetPassword',
] as const;
type Path = (typeof paths)[number];
type Actor = { id: string; email: string; cookie: string; sessionId: string };
let now: number, directory: string, logs: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let actors: Actor[];
const worlds = new Set<string>();
const signupEmails = new Set<string>();
async function server(transport: MailTransport) {
  return buildServer({
    db,
    publicOrigin: origin,
    now: () => now,
    mailTransport: transport,
    logStream: new Writable({
      write(chunk, _encoding, done) {
        logs += String(chunk);
        done();
      },
    }),
  });
}
async function call(
  path: Path | 'auth.login' | 'auth.signup',
  input: unknown,
  cookie?: string,
  requestOrigin: string | null = origin,
) {
  const mutation = appRouter._def.procedures[path]._def.type === 'mutation';
  const encoded = JSON.stringify({ 0: input });
  const response = await app.inject({
    method: mutation ? 'POST' : 'GET',
    url: `/trpc/${path}?batch=1${mutation ? '' : '&input=' + encodeURIComponent(encoded)}`,
    headers: { ...(requestOrigin === null ? {} : { origin: requestOrigin }), ...(cookie ? { cookie } : {}) },
    ...(mutation ? { payload: { 0: input } } : {}),
  });
  return {
    status: response.statusCode,
    body: response.json()[0] as {
      result?: { data: Record<string, unknown> };
      error?: { data: { code: string; reason: string | null } };
    },
    retryAfter: response.headers['retry-after'],
    cookie: [response.headers['set-cookie']]
      .flat()
      .find((value) => value?.startsWith('sid='))
      ?.split(';')[0],
  };
}
async function mailbox() {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json'));
  return Promise.all(
    files.map(
      async (file) =>
        JSON.parse(await readFile(join(directory, file), 'utf8')) as {
          to: string;
          subject: string;
          text: string;
          sentAt: string;
        },
    ),
  );
}
function token(message: { text: string }) {
  const link = new URL(message.text.match(/https?:\/\/\S+/u)![0]);
  expect(link.origin).toBe(origin);
  expect(link.search).toBe('');
  return new URLSearchParams(link.hash.slice(1)).get('token')!;
}
async function snapshot() {
  const ids = actors.map((actor) => actor.id);
  return hashState(
    JSON.parse(
      JSON.stringify({
        users: await db.user.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } }),
        sessions: await db.session.findMany({ where: { userId: { in: ids } }, orderBy: { id: 'asc' } }),
        tokens: await db.accountToken.findMany({ where: { userId: { in: ids } }, orderBy: { id: 'asc' } }),
        consents: await db.consentRecord.findMany({ where: { userId: { in: ids } }, orderBy: { id: 'asc' } }),
      }),
    ),
  );
}
beforeEach(async () => {
  now = Date.UTC(2026, 10, 2, 0, 0, 30);
  logs = '';
  actors = [];
  directory = await mkdtemp(join(tmpdir(), 't302-account-api-'));
  for (let index = 0; index < 2; index++) {
    const actor = await db.user.create({
      data: { email: `${randomUUID()}@example.test`, passwordHash: 'before-reset' },
    });
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId: actor.id, expiresAt: session.expiresAt } });
    actors.push({ id: actor.id, email: actor.email, cookie: `sid=${session.token}`, sessionId: session.id });
  }
  app = await server(createMailTransport({ MAIL_TRANSPORT: 'capture', MAIL_CAPTURE_DIR: directory }));
  await app.ready();
});
afterEach(async () => {
  await app?.close();
  await db.world.deleteMany({ where: { id: { in: [...worlds] } } });
  worlds.clear();
  await db.user.deleteMany({ where: { id: { in: actors.map((actor) => actor.id) } } });
  await db.user.deleteMany({ where: { email: { in: [...signupEmails] } } });
  signupEmails.clear();
  if (directory) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('t302-account-api-'))
      throw new Error('시험 메일함 정리 경로를 확인하세요.');
    await rm(directory, { recursive: true });
  }
});
afterAll(() => db.$disconnect());

for (const path of paths)
  for (const category of categories)
    it(
      `${path} ${category}`,
      authzCase(path, category, async () => {
        const actor = actors[0]!;
        let input: unknown = undefined;
        const purpose = path === 'account.verifyEmail' ? 'VERIFY_EMAIL' : 'RESET_PASSWORD';
        if (path === 'account.verifyEmail' || path === 'account.resetPassword') {
          const issued = (await issueAccountToken(db, actor.id, purpose, now))!;
          input = { token: issued.token, ...(path === 'account.resetPassword' ? { password: randomUUID() } : {}) };
        } else if (path === 'account.requestPasswordReset') input = { email: actor.email };
        if (category === 'otherUser') input = { ...(input as object), userId: actors[1]!.id };
        if (category === 'invalidInput') input = { unexpected: true };
        if (category === 'sanctioned')
          await db.user.update({ where: { id: actor.id }, data: { status: 'SANCTIONED' } });
        const before = await snapshot();
        const response = await call(path, input, category === 'unauthenticated' ? undefined : actor.cookie);
        const protectedPath = path === 'account.get' || path === 'account.resendVerification';
        const denied =
          category === 'otherUser' ||
          category === 'invalidInput' ||
          (protectedPath && (category === 'unauthenticated' || category === 'sanctioned')) ||
          (!protectedPath && category === 'sanctioned' && path !== 'account.requestPasswordReset');
        expect(response.status).toBe(
          denied ? (protectedPath && ['unauthenticated', 'sanctioned'].includes(category) ? 401 : 400) : 200,
        );
        if (denied) {
          expect(await snapshot()).toBe(before);
          expect(await mailbox()).toHaveLength(0);
        } else if (path === 'account.get') {
          expect(response.body.result?.data.email === actor.email).toBe(true);
          expect(response.body.result?.data.emailVerified).toBe(false);
          expect(response.body.result?.data.consents).toEqual([]);
        } else if (path === 'account.resendVerification' || path === 'account.requestPasswordReset') {
          expect(await mailbox()).toHaveLength(category === 'sanctioned' ? 0 : 1);
        } else if (path === 'account.verifyEmail') {
          expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).emailVerifiedAt?.getTime()).toBe(now);
        } else {
          expect(await db.session.count({ where: { userId: actor.id } })).toBe(0);
          expect(await db.session.count({ where: { userId: actors[1]!.id } })).toBe(1);
          expect(
            await verifyPassword(
              (await db.user.findUniqueOrThrow({ where: { id: actor.id } })).passwordHash,
              (input as { password: string }).password,
            ),
          ).toBe(true);
        }
        for (const secret of [
          actor.email,
          actor.cookie.slice(4),
          (input as { token?: string } | undefined)?.token,
        ].filter(Boolean) as string[])
          expect(logs.includes(secret)).toBe(false);
      }),
    );

it('재발급·분 창 경계·인증 후 다시 보내기와 토큰 재사용을 실제 메일함으로 확인한다', async () => {
  const actor = actors[0]!;
  expect((await call('account.resendVerification', undefined, actor.cookie)).status).toBe(200);
  const first = token((await mailbox())[0]!);
  const blocked = await call('account.resendVerification', undefined, actor.cookie);
  expect(blocked.status).toBe(429);
  expect(Number(blocked.retryAfter)).toBe(30);
  now += 30_000;
  expect((await call('account.resendVerification', undefined, actor.cookie)).status).toBe(200);
  const messages = await mailbox();
  const second = messages.map(token).find((value) => value !== first)!;
  const invalid = await call('account.verifyEmail', { token: first });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error?.data.reason).toBe('TOKEN_INVALID');
  expect((await call('account.verifyEmail', { token: second })).status).toBe(200);
  expect((await call('account.verifyEmail', { token: second })).body.error?.data.reason).toBe('TOKEN_INVALID');
  expect((await call('account.get', undefined, actor.cookie)).body.result?.data.emailVerified).toBe(true);
  expect((await call('account.resendVerification', undefined, actor.cookie)).status).toBe(200);
  expect(await mailbox()).toHaveLength(2);
});

it('인증 하루5번과 다음 UTC 날짜의 경계를 지킨다', async () => {
  for (let count = 0; count < 5; count++) {
    expect((await call('account.resendVerification', undefined, actors[0]!.cookie)).status).toBe(200);
    now += 60_000;
  }
  expect((await call('account.resendVerification', undefined, actors[0]!.cookie)).status).toBe(429);
  now = Date.UTC(2026, 10, 3);
  expect((await call('account.resendVerification', undefined, actors[0]!.cookie)).status).toBe(200);
  expect(await mailbox()).toHaveLength(6);
});

it('계정 유무·제재·탈퇴·한도 초과의 재설정 응답은 같고 실제 메일만 제한한다', async () => {
  const actor = actors[0]!;
  const expected = { status: 200, body: { result: { data: { ok: true } } }, retryAfter: undefined };
  for (const email of [actor.email.toUpperCase() + ' ', `${randomUUID()}@example.test`])
    for (let count = 0; count < 4; count++)
      expect(await call('account.requestPasswordReset', { email })).toEqual(expected);
  expect(await mailbox()).toHaveLength(3);
  for (const status of ['SANCTIONED', 'WITHDRAWN'] as const) {
    await db.user.update({ where: { id: actors[1]!.id }, data: { status } });
    expect(await call('account.requestPasswordReset', { email: actors[1]!.email })).toEqual(expected);
  }
  expect(await mailbox()).toHaveLength(3);
});

it.each([
  ['VERIFY_EMAIL', 86_400_000],
  ['RESET_PASSWORD', 1_800_000],
] as const)('%s 링크의 만료 경계를 실제 HTTP로 확인한다', async (purpose, ttl) => {
  for (const [index, elapsed] of [ttl - 1, ttl].entries()) {
    const actor = actors[index]!;
    const issued = (await issueAccountToken(db, actor.id, purpose, now))!;
    const startedAt = now;
    now += elapsed;
    const response = await call(purpose === 'VERIFY_EMAIL' ? 'account.verifyEmail' : 'account.resetPassword', {
      token: issued.token,
      ...(purpose === 'RESET_PASSWORD' ? { password: randomUUID() } : {}),
    });
    expect(response.status).toBe(index === 0 ? 200 : 400);
    if (index === 1) expect(response.body.error?.data.reason).toBe('TOKEN_INVALID');
    now = startedAt;
  }
});

it('같은 재설정 메일을 동시에 소비하면 한 번만 성공하고 모든 기존 세션을 폐기한다', async () => {
  const actor = actors[0]!,
    oldPassword = randomUUID(),
    nextPassword = randomUUID();
  await db.user.update({ where: { id: actor.id }, data: { passwordHash: await hashPassword(oldPassword) } });
  expect((await call('account.requestPasswordReset', { email: actor.email })).status).toBe(200);
  const secret = token((await mailbox())[0]!);
  const responses = await Promise.all([
    call('account.resetPassword', { token: secret, password: nextPassword }),
    call('account.resetPassword', { token: secret, password: nextPassword }),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
  expect(responses.find((response) => response.status === 400)?.body.error?.data.reason).toBe('TOKEN_INVALID');
  expect((await call('auth.login', { email: actor.email, password: oldPassword })).status).toBe(401);
  expect(await db.session.count({ where: { userId: actor.id } })).toBe(0);
  expect((await call('auth.login', { email: actor.email, password: nextPassword })).status).toBe(200);
  for (const value of [secret, oldPassword, nextPassword, actor.email]) expect(logs.includes(value)).toBe(false);
});

it('재설정 commit 뒤 다른 API의 본인 SSE도 즉시 끝내고 타인 연결은 보존한다', async () => {
  const initial = commandInitial();
  initial.generals[0]!.userId = actors[0]!.id;
  initial.generals[1]!.userId = actors[1]!.id;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '계정 SSE 폐기 전용',
    turnTermMinutes: 1,
    endYear: null,
  });
  worlds.add(worldId);
  const secondSession = newSession(now);
  await db.session.create({
    data: { id: secondSession.id, userId: actors[0]!.id, expiresAt: secondSession.expiresAt },
  });
  const otherApp = await buildServer({ db, logging: false, realtime: { connectionString: url!, heartbeatMs: 60_000 } });
  const streams: Array<{ controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> }> = [];
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const otherBase = await otherApp.listen({ host: '127.0.0.1', port: 0 });
    for (const [endpoint, cookie] of [
      [base, actors[0]!.cookie],
      [otherBase, `sid=${secondSession.token}`],
      [otherBase, actors[1]!.cookie],
    ]) {
      const controller = new AbortController();
      const response = await fetch(`${endpoint}/sse?worldId=${worldId}`, {
        headers: { origin, cookie: cookie! },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      streams.push({ controller, reader });
      expect(new TextDecoder().decode((await reader.read()).value).includes('event: ready')).toBe(true);
    }
    await call('account.requestPasswordReset', { email: actors[0]!.email });
    const secret = token((await mailbox())[0]!);
    const started = Date.now();
    expect((await call('account.resetPassword', { token: secret, password: randomUUID() })).status).toBe(200);
    expect(
      (await Promise.all(streams.slice(0, 2).map((stream) => stream.reader.read()))).map((result) => result.done),
    ).toEqual([true, true]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await db.session.count({ where: { userId: actors[0]!.id } })).toBe(0);
    expect((await call('account.get', undefined, actors[1]!.cookie)).status).toBe(200);
    expect((await call('account.get', undefined, actors[0]!.cookie)).status).toBe(401);
    expect(await notifyWorld(db, worldId, { kind: 'turn.result', target: { generalId: 2 } })).toBe(true);
    const otherFrame = await streams[2]!.reader.read();
    expect(otherFrame.done).toBe(false);
    expect(new TextDecoder().decode(otherFrame.value).includes('event: turn.result')).toBe(true);
  } finally {
    for (const stream of streams) stream.controller.abort();
    await Promise.allSettled(streams.map((stream) => stream.reader.cancel()));
    await otherApp.close();
  }
});

it('공개 토큰 소비는 IP 합산30회에서 차단하고 경계 뒤에만 유효 토큰을 소비한다', async () => {
  const issued = (await issueAccountToken(db, actors[0]!.id, 'RESET_PASSWORD', now))!;
  const before = await snapshot();
  for (let count = 0; count < 30; count++) {
    const response = await call(count % 2 === 0 ? 'account.verifyEmail' : 'account.resetPassword', {
      token: 'a'.repeat(43),
      ...(count % 2 === 1 ? { password: randomUUID() } : {}),
    });
    expect(response.status).toBe(400);
    expect(response.body.error?.data.reason).toBe('TOKEN_INVALID');
  }
  const blocked = await call('account.resetPassword', { token: issued.token, password: randomUUID() });
  expect(blocked.status).toBe(429);
  expect(blocked.body.error?.data.reason).toBeNull();
  expect(Number(blocked.retryAfter)).toBe(870);
  expect(await snapshot()).toBe(before);
  now = Date.UTC(2026, 10, 2, 0, 15);
  expect((await call('account.resetPassword', { token: issued.token, password: randomUUID() })).status).toBe(200);
});

it('메일 발송 실패도 재설정 응답이나 로그에 계정·토큰·전송 오류를 드러내지 않는다', async () => {
  await app.close();
  const privateFailure = randomUUID();
  app = await server({
    async send() {
      throw new Error(privateFailure);
    },
  });
  const known = await call('account.requestPasswordReset', { email: actors[0]!.email });
  expect(await call('account.requestPasswordReset', { email: `${randomUUID()}@example.test` })).toEqual(known);
  expect(known.status).toBe(200);
  for (const value of [privateFailure, actors[0]!.email]) expect(logs.includes(value)).toBe(false);
  expect(await db.accountToken.count({ where: { userId: actors[0]!.id } })).toBe(1);
});

it.each([null, 'https://other.test'])('재설정도 기존 같은 출처 보호를 유지한다(%s)', async (requestOrigin) => {
  const before = await snapshot();
  expect(
    (await call('account.requestPasswordReset', { email: actors[0]!.email }, undefined, requestOrigin)).status,
  ).toBe(403);
  expect(await snapshot()).toBe(before);
  expect(await mailbox()).toHaveLength(0);
});

it('가입은 계정·세션·인증 해시를 함께 저장한 뒤 메일을 보내고 링크를 한 번만 소비한다', async () => {
  const email = `${randomUUID()}@example.test`;
  signupEmails.add(email);
  const password = randomUUID();
  let committedBeforeDelivery = false;
  await app.close();
  const capture = createMailTransport({ MAIL_TRANSPORT: 'capture', MAIL_CAPTURE_DIR: directory });
  app = await server({
    async send(message) {
      const committed = await db.user.findUnique({ where: { email } });
      committedBeforeDelivery =
        committed !== null &&
        (await db.session.count({ where: { userId: committed.id } })) === 1 &&
        (await db.accountToken.count({ where: { userId: committed.id } })) === 1;
      await capture.send(message);
    },
  });
  const response = await call('auth.signup', { email: email.toUpperCase(), password });
  expect(response.status).toBe(200);
  expect(committedBeforeDelivery).toBe(true);
  expect(response.cookie?.startsWith('sid=')).toBe(true);
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  expect(user.emailVerifiedAt).toBeNull();
  expect(await verifyPassword(user.passwordHash, password)).toBe(true);
  const mail = await mailbox();
  expect(mail).toHaveLength(1);
  expect(mail[0]!.to === email).toBe(true);
  const secret = token(mail[0]!);
  const rows = await db.accountToken.findMany({ where: { userId: user.id } });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id === hashToken(secret)).toBe(true);
  expect(rows[0]!.purpose).toBe('VERIFY_EMAIL');
  expect(rows[0]!.expiresAt.getTime() - now).toBe(86_400_000);
  expect(rows[0]!.usedAt).toBeNull();
  expect(await db.session.count({ where: { id: hashToken(response.cookie!.slice(4)), userId: user.id } })).toBe(1);
  for (const value of [secret, password, email]) expect(logs.includes(value)).toBe(false);
  for (const value of [secret, password]) expect(JSON.stringify(response.body).includes(value)).toBe(false);
  expect((await call('account.verifyEmail', { token: secret })).status).toBe(200);
  expect((await call('account.verifyEmail', { token: secret })).status).toBe(400);
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt?.getTime()).toBe(now);
});

it('중복 가입은 기존 계정·세션·인증 토큰을 보존하고 메일을 보내지 않는다', async () => {
  await issueAccountToken(db, actors[0]!.id, 'VERIFY_EMAIL', now);
  const before = await snapshot();
  expect(
    (await call('auth.signup', { email: actors[0]!.email, password: randomUUID() }, actors[1]!.cookie)).status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
  expect(await mailbox()).toHaveLength(0);
});

it('가입 메일 실패 뒤에도 계정은 남고 본인이 새 인증 링크를 요청할 수 있다', async () => {
  const email = `${randomUUID()}@example.test`;
  signupEmails.add(email);
  const privateFailure = randomUUID();
  await app.close();
  app = await server({
    async send() {
      throw new Error(privateFailure);
    },
  });
  const response = await call('auth.signup', { email, password: randomUUID() });
  expect(response.status).toBe(200);
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  const previous = await db.accountToken.findFirstOrThrow({ where: { userId: user.id } });
  expect(user.emailVerifiedAt).toBeNull();
  expect(logs.includes(privateFailure)).toBe(false);
  expect(logs.includes(email)).toBe(false);
  await app.close();
  app = await server(createMailTransport({ MAIL_TRANSPORT: 'capture', MAIL_CAPTURE_DIR: directory }));
  expect((await call('account.resendVerification', undefined, response.cookie)).status).toBe(200);
  expect((await db.accountToken.findUniqueOrThrow({ where: { id: previous.id } })).usedAt).not.toBeNull();
  expect((await call('account.verifyEmail', { token: token((await mailbox())[0]!) })).status).toBe(200);
});

it('인증 토큰 저장의 실제 DB 오류는 가입·세션 교체를 모두 롤백하고 메일을 보내지 않는다', async () => {
  const id = randomUUID().replaceAll('-', '');
  const name = `t302_signup_${id}`;
  const email = `${id}@example.test`;
  signupEmails.add(email);
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  const before = await snapshot();
  await db.$executeRawUnsafe(
    `CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM "User" WHERE id = NEW."userId" AND email = '${email}') THEN RAISE EXCEPTION 'controlled-signup-token-failure'; END IF; RETURN NEW; END $$`,
  );
  try {
    await db.$executeRawUnsafe(
      `CREATE TRIGGER "${name}" BEFORE INSERT ON "AccountToken" FOR EACH ROW EXECUTE FUNCTION "${name}"()`,
    );
    const failed = await call('auth.signup', { email, password: randomUUID() }, actors[0]!.cookie);
    expect(failed.status).toBe(500);
    expect(failed.cookie).toBeUndefined();
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect(await snapshot()).toBe(before);
    expect(await mailbox()).toHaveLength(0);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON "AccountToken"`);
    await db.$executeRawUnsafe(`DROP FUNCTION "${name}"()`);
  }
  expect((await call('auth.signup', { email, password: randomUUID() }, actors[0]!.cookie)).status).toBe(200);
  expect(await mailbox()).toHaveLength(1);
});
