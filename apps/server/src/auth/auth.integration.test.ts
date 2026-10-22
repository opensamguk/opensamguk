import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { buildServer } from '../server';
import { hashToken, SESSION_SECONDS, SESSION_RENEW_MS } from './session';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
let now = 1_800_000_000_000;
let logText = '';
const stream = new Writable({
  write(chunk, _encoding, done) {
    logText += String(chunk);
    done();
  },
});
const app = await buildServer({ db, now: () => now, logStream: stream, secureCookies: true });
beforeAll(async () => {
  await db.world.deleteMany();
  await db.user.deleteMany();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.user.deleteMany();
  await db.$disconnect();
});
const password = randomBytes(24).toString('base64url');
async function request(name: string, input?: unknown, sid?: string) {
  const response = await app.inject({
    method: name === 'me' ? 'GET' : 'POST',
    url: `/trpc/auth.${name}?batch=1`,
    headers: { origin: 'http://127.0.0.1:5173', ...(sid ? { cookie: sid } : {}) },
    ...(name === 'me' ? {} : { payload: input === undefined ? {} : { 0: input } }),
  });
  const body = response.json()[0] as {
    result?: { data: { user?: { id: string; email: string } | null; ok?: boolean } };
    error?: { data: { code: string }; message: string };
  };
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies.filter((value) => value.startsWith('sid=')).at(-1);
  return { response, body, cookie: cookie?.split(';')[0], header: cookie };
}
describe('AC-M1-05 실제 HTTP·DB 인증', () => {
  it('가입 → me → 로그아웃 → 로그인, 정규화·해시·쿠키 속성', async () => {
    const signup = await request('signup', { email: ' Alice@Example.com ', password });
    expect(signup.body.result?.data.user?.email).toBe('alice@example.com');
    expect(signup.header).toContain('HttpOnly');
    expect(signup.header).toContain('Secure');
    expect(signup.header).toContain('SameSite=Lax');
    expect(signup.header).toContain('Path=/');
    const row = await db.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(row.passwordHash.split('$')[3]!.split(',').sort()).toEqual(['m=65536', 'p=4', 't=3']);
    const token = signup.cookie!.slice(4);
    const session = await db.session.findUniqueOrThrow({ where: { id: hashToken(token) } });
    expect(session.id === token).toBe(false);
    expect(JSON.stringify([row, session]).includes(password)).toBe(false);
    expect((await request('me', undefined, signup.cookie)).body.result?.data.user?.id).toBe(row.id);
    expect((await request('logout', undefined, signup.cookie)).body.result?.data.ok).toBe(true);
    expect((await request('me', undefined, signup.cookie)).body.result?.data.user).toBeNull();
    const login = await request('login', { email: 'ALICE@example.com', password });
    expect(login.body.result?.data.user?.id).toBe(row.id);
    expect(logText.includes(password)).toBe(false);
    expect(logText.includes(token)).toBe(false);
    expect(logText.includes(login.cookie!.slice(4))).toBe(false);
  });
  it('무인증·위조·만료 세션과 활동 연장을 처리한다', async () => {
    expect((await request('me')).body.result?.data.user).toBeNull();
    expect(
      (await request('me', undefined, `sid=${randomBytes(32).toString('base64url')}`)).body.result?.data.user,
    ).toBeNull();
    const login = await request('login', { email: 'alice@example.com', password });
    const id = hashToken(login.cookie!.slice(4));
    const originalExpiry = (await db.session.findUniqueOrThrow({ where: { id } })).expiresAt.getTime();
    now += 60_000;
    const active = await request('me', undefined, login.cookie);
    expect(active.header).toBeUndefined();
    expect((await db.session.findUniqueOrThrow({ where: { id } })).expiresAt.getTime()).toBe(originalExpiry);
    now = originalExpiry - SESSION_RENEW_MS - 1;
    expect((await request('me', undefined, login.cookie)).header).toBeUndefined();
    now += 1;
    const renewed = await Promise.all([request('me', undefined, login.cookie), request('me', undefined, login.cookie)]);
    expect(renewed.every((r) => r.body.result?.data.user?.email === 'alice@example.com')).toBe(true);
    expect(renewed.filter((r) => r.header?.includes(`Max-Age=${SESSION_SECONDS}`))).toHaveLength(1);
    expect((await db.session.findUniqueOrThrow({ where: { id } })).expiresAt.getTime()).toBe(
      now + SESSION_SECONDS * 1000,
    );
    await db.session.update({ where: { id }, data: { expiresAt: new Date(now) } });
    expect((await request('me', undefined, login.cookie)).body.result?.data.user).toBeNull();
  });
  it('중복·잘못된 비밀번호·없는 계정·잘못된 입력을 구분한다', async () => {
    expect((await request('signup', { email: 'alice@example.com', password })).body.error?.data.code).toBe('CONFLICT');
    const bad = await request('login', { email: 'alice@example.com', password: password + '!' });
    const missing = await request('login', { email: 'missing@example.com', password });
    expect(bad.body.error?.data.code).toBe('UNAUTHORIZED');
    expect(bad.body.error?.message).toBe(missing.body.error?.message);
    for (const input of [
      { email: 'bad', password },
      { email: 'x@example.com', password: 'short' },
      { email: 'x@example.com', password, userId: 'other' },
    ]) {
      expect((await request('signup', input)).body.error?.data.code).toBe('BAD_REQUEST');
    }
    expect(logText.includes(password)).toBe(false);
  });
  it('다른 사용자의 세션은 로그아웃되지 않고 제재 계정은 인증되지 않는다', async () => {
    const bob = await request('signup', { email: 'bob@example.com', password });
    const alice = await request('login', { email: 'alice@example.com', password });
    await request('logout', undefined, alice.cookie);
    expect((await request('me', undefined, bob.cookie)).body.result?.data.user?.email).toBe('bob@example.com');
    await db.user.update({ where: { email: 'bob@example.com' }, data: { status: 'SANCTIONED' } });
    expect((await request('me', undefined, bob.cookie)).body.result?.data.user).toBeNull();
    expect((await request('login', { email: 'bob@example.com', password })).body.error?.data.code).toBe('UNAUTHORIZED');
  });
});
