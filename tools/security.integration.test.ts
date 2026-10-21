import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { hashPassword } from '../apps/server/src/auth/password';
import { hashToken, newSession } from '../apps/server/src/auth/session';
import { readFixture } from '../apps/server/test/readFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const origin = 'http://127.0.0.1:5173';
const password = randomUUID();
let now = 1_800_000_000_001;
let user: { id: string; email: string };
let other: { id: string; email: string };
let worldId: string;
let logText = '';
const logStream = new Writable({
  write(chunk, _encoding, done) {
    logText += String(chunk);
    done();
  },
});

type Response = {
  status: number;
  headers: import('node:http').IncomingHttpHeaders;
  data: unknown;
  code?: string;
  reason?: unknown;
};
async function send(
  base: string,
  path: string,
  data: unknown,
  options: { headers?: Record<string, string>; localAddress?: string; method?: string; raw?: string } = {},
): Promise<Response> {
  const body = options.raw ?? JSON.stringify({ 0: data });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}/trpc/${path}?batch=1`,
      {
        method: options.method ?? 'POST',
        localAddress: options.localAddress,
        headers: { origin, 'content-type': 'application/json', ...options.headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (value) => {
          text += value;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(text);
            const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              data: envelope.result?.data,
              code: envelope.error?.data?.code,
              reason: envelope.error?.data?.reason,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
async function withServer(
  fn: (base: string) => Promise<void>,
  options: Partial<Parameters<typeof buildServer>[0]> = {},
) {
  now = 1_800_000_000_001;
  const app = await buildServer({ db, publicOrigin: origin, now: () => now, logStream, ...options });
  try {
    await fn(await app.listen({ host: '127.0.0.1', port: 0 }));
  } finally {
    await app.close();
  }
}
async function snapshot() {
  const rows = await Promise.all([
    db.user.findMany({ orderBy: { id: 'asc' } }),
    db.session.findMany({ orderBy: { id: 'asc' } }),
    db.inputEvent.findMany({ orderBy: { id: 'asc' } }),
    db.general.findMany({ orderBy: { id: 'asc' } }),
    db.generalTurn.findMany({ orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
  ]);
  return {
    counts: rows.map((table) => table.length),
    hash: createHash('sha256')
      .update(JSON.stringify(rows, (_, value) => (typeof value === 'bigint' ? String(value) : value)))
      .digest('hex'),
  };
}
async function cookie(id = user.id) {
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
  return `sid=${session.token}`;
}
const credentials = () => ({ email: user.email, password });
const nextWindow = (windowMs: number) => {
  now = (Math.floor(now / windowMs) + 1) * windowMs;
};
beforeAll(async () => {
  await db.world.deleteMany();
  await db.user.deleteMany();
  const passwordHash = await hashPassword(password);
  user = await db.user.create({
    data: { email: `${randomUUID()}@example.test`, passwordHash },
    select: { id: true, email: true },
  });
  other = await db.user.create({
    data: { email: `${randomUUID()}@example.test`, passwordHash },
    select: { id: true, email: true },
  });
  const state = await readFixture();
  state.generals[0]!.userId = user.id;
  state.generals[2]!.userId = other.id;
  ({ worldId } = await saveInitialWorld(db, state, { name: '보안 HTTP', turnTermMinutes: 60 }));
});
afterAll(async () => {
  await db.world.deleteMany();
  await db.user.deleteMany();
  await db.$disconnect();
});

describe('T3-04 실제 TCP HTTP·PostgreSQL 보안', () => {
  it('로그인 실패5회 뒤 맞는 비밀번호도 거부하며 다른 IP·창 경계는 독립이다', async () =>
    withServer(async (base) => {
      for (let i = 0; i < 5; i++)
        expect(
          (await send(base, 'auth.login', { email: ` ${user.email.toUpperCase()} `, password: password + '!' })).code,
        ).toBe('UNAUTHORIZED');
      const before = await snapshot();
      const blocked = await send(base, 'auth.login', credentials());
      expect(blocked.code).toBe('TOO_MANY_REQUESTS');
      expect(blocked.reason).toBeNull();
      expect(blocked.headers['retry-after']).toBe(String(Math.ceil((900_000 - (now % 900_000)) / 1000)));
      expect(await snapshot()).toEqual(before);
      expect((await send(base, 'auth.login', credentials(), { localAddress: '127.0.0.2' })).status).toBe(200);
      nextWindow(900_000);
      expect((await send(base, 'auth.login', credentials())).status).toBe(200);
    }));
  it('성공 로그인은 앞선 실패 계수를 지우지 않는다', async () =>
    withServer(async (base) => {
      for (let i = 0; i < 4; i++)
        expect((await send(base, 'auth.login', { ...credentials(), password: password + '!' })).code).toBe(
          'UNAUTHORIZED',
        );
      expect((await send(base, 'auth.login', credentials())).status).toBe(200);
      expect((await send(base, 'auth.login', { ...credentials(), password: password + '!' })).code).toBe(
        'UNAUTHORIZED',
      );
      expect((await send(base, 'auth.login', credentials())).code).toBe('TOO_MANY_REQUESTS');
    }));
  it('Caddy 한 단계 설정은 오른쪽 실제 전달 IP만 믿는다', async () =>
    withServer(
      async (base) => {
        for (let i = 0; i < 5; i++)
          expect(
            (
              await send(
                base,
                'auth.login',
                { ...credentials(), password: password + '!' },
                { headers: { 'x-forwarded-for': `198.51.100.${i + 1}, 192.0.2.10` } },
              )
            ).code,
          ).toBe('UNAUTHORIZED');
        expect(
          (
            await send(base, 'auth.login', credentials(), {
              headers: { 'x-forwarded-for': '198.51.100.99, 192.0.2.10' },
            })
          ).code,
        ).toBe('TOO_MANY_REQUESTS');
        expect(
          (
            await send(base, 'auth.login', credentials(), {
              headers: { 'x-forwarded-for': '198.51.100.99, 192.0.2.11' },
            })
          ).status,
        ).toBe(200);
      },
      { trustProxy: true },
    ));
  it('동일 IP 로그인31번째는 차단하며 위조 X-Forwarded-For는 기본 설정에서 한도를 피하지 못한다', async () =>
    withServer(async (base) => {
      for (let i = 0; i < 30; i++) expect((await send(base, 'auth.login', credentials())).status).toBe(200);
      const before = await snapshot();
      const blocked = await send(base, 'auth.login', credentials(), { headers: { 'x-forwarded-for': '198.51.100.2' } });
      expect(blocked.status).toBe(429);
      expect(await snapshot()).toEqual(before);
    }));
  it('가입10회 뒤11번째는429이며 창 경계에서 다시 허용한다', async () =>
    withServer(async (base) => {
      const signup = () => ({ email: `${randomUUID()}@example.test`, password });
      for (let i = 0; i < 10; i++) expect((await send(base, 'auth.signup', signup())).status).toBe(200);
      const before = await snapshot();
      const blocked = await send(base, 'auth.signup', signup());
      expect(blocked.status).toBe(429);
      expect(blocked.code).toBe('TOO_MANY_REQUESTS');
      expect(blocked.headers['retry-after']).toBe(String(Math.ceil((3_600_000 - (now % 3_600_000)) / 1000)));
      expect(await snapshot()).toEqual(before);
      nextWindow(3_600_000);
      expect((await send(base, 'auth.signup', signup())).status).toBe(200);
    }));
  it('인증 변경120회 한도는 사용자별이며121번째는 예턴·이벤트·revision을 바꾸지 않는다', async () =>
    withServer(async (base) => {
      const ownCookie = await cookie();
      const otherCookie = await cookie(other.id);
      for (let i = 0; i < 120; i++) {
        const revision = (
          await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: user.id } } })
        ).turnRevision;
        const response = await send(
          base,
          'turns.set',
          { worldId, revision, slots: Array.from({ length: 30 }, () => null) },
          { headers: { cookie: ownCookie } },
        );
        expect(response.data).toHaveProperty('ok', true);
      }
      await db.session.update({
        where: { id: hashToken(ownCookie.slice(4)) },
        data: { expiresAt: new Date(now + 120_000) },
      });
      const before = await snapshot();
      const data = { worldId, revision: 120, op: { shift: 1 } };
      const blocked = await send(base, 'turns.edit', data, { headers: { cookie: ownCookie } });
      expect(blocked.code).toBe('TOO_MANY_REQUESTS');
      expect(blocked.headers['retry-after']).toBe(String(Math.ceil((60_000 - (now % 60_000)) / 1000)));
      expect(blocked.headers['set-cookie'] === undefined).toBe(true);
      expect(await snapshot()).toEqual(before);
      expect(
        (await send(base, 'turns.edit', { ...data, revision: 0 }, { headers: { cookie: otherCookie } })).data,
      ).toHaveProperty('ok', true);
      nextWindow(60_000);
      expect((await send(base, 'turns.edit', data, { headers: { cookie: ownCookie } })).data).toHaveProperty(
        'ok',
        true,
      );
    }));
  it('다른 Origin·누락 Origin·폼·text/plain·null Origin은 DB 접근 전에 거부한다', async () =>
    withServer(async (base) => {
      for (const [headers, status] of [
        [{ origin: 'https://attacker.invalid' }, 403],
        [{ origin: '' }, 403],
        [{ origin: 'null' }, 403],
        [{ origin: origin + '/' }, 403],
        [{ origin: 'https://attacker.invalid', 'sec-fetch-site': 'same-origin' }, 403],
        [{ 'content-type': 'text/plain' }, 415],
        [{ 'content-type': 'application/x-www-form-urlencoded' }, 415],
      ] as const) {
        const before = await snapshot();
        expect(
          (await send(base, 'auth.signup', { email: `${randomUUID()}@example.test`, password }, { headers })).status,
        ).toBe(status);
        expect(await snapshot()).toEqual(before);
      }
      // 실제 Origin 헤더 자체를 생략한 요청도 확인한다.
      const res = await fetch(`${base}/trpc/auth.logout?batch=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(403);
      const sameOrigin = await fetch(`${base}/trpc/auth.logout?batch=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: '{}',
      });
      expect(sameOrigin.status).toBe(200);
      const sseRejected = await fetch(`${base}/trpc/health`, {
        headers: { accept: 'text/event-stream, */*', origin: 'https://attacker.invalid' },
      });
      expect(sseRejected.status).toBe(403);
      const sseAllowed = await fetch(`${base}/trpc/health`, { headers: { accept: 'text/event-stream', origin } });
      expect(sseAllowed.status).toBe(200);
      expect(
        (
          await send(base, 'auth.login', credentials(), {
            headers: { 'content-type': 'application/json; charset=utf-8' },
          })
        ).status,
      ).toBe(200);
    }));
  it('운영 쿠키 Secure·HttpOnly·SameSite와 보안 헤더를 유지하고 CORS를 열지 않는다', async () =>
    withServer(
      async (base) => {
        const response = await send(base, 'auth.login', credentials(), {
          headers: { origin: 'https://game.example.test' },
        });
        expect(response.status).toBe(200);
        const cookies = response.headers['set-cookie']!.join(';');
        for (const part of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) expect(cookies.includes(part)).toBe(true);
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['referrer-policy']).toBe('same-origin');
        expect(response.headers['x-frame-options']).toBe('DENY');
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
        const rejected = await send(base, 'auth.logout', undefined);
        expect(rejected.status).toBe(403);
        expect(rejected.headers['x-frame-options']).toBe('DENY');
      },
      { production: true, publicOrigin: 'https://game.example.test' },
    ));
  it('Secure 없는 운영 설정·잘못된 공개 출처로는 시작하지 않는다', async () => {
    await expect(
      buildServer({ db, production: true, secureCookies: false, publicOrigin: 'https://game.example.test' }),
    ).rejects.toThrow('Secure');
    await expect(buildServer({ db, production: true, publicOrigin: origin })).rejects.toThrow('PUBLIC_ORIGIN');
    await expect(buildServer({ db, publicOrigin: origin + '/path' })).rejects.toThrow('PUBLIC_ORIGIN');
  });
  it('프로세스 재시작은 계수를 비우고 민감한 키를 로그에 남기지 않는다', async () => {
    await withServer(async (base) => {
      for (let i = 0; i < 5; i++) await send(base, 'auth.login', { ...credentials(), password: password + '!' });
    });
    await withServer(async (base) => {
      expect((await send(base, 'auth.login', credentials())).status).toBe(200);
    });
    for (const secret of [password, user.email, other.email, '127.0.0.2', '198.51.100.2'])
      expect(logText.includes(secret)).toBe(false);
  });
});
