import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as passwordModule from './password';
import { createDb } from '@opensamguk/db';
import { issueAccountToken, resetPasswordToken, verifyEmailToken } from './accountTokenStore';
import { hashToken, newSession } from './session';
import { hashPassword, verifyPassword } from './password';
import { buildServer } from '../server';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = Date.UTC(2026, 9, 28);
const users = new Set<string>();
async function user() {
  const created = await db.user.create({
    data: { email: `${randomUUID()}@example.test`, passwordHash: 'before-reset' },
  });
  users.add(created.id);
  return created;
}

function isControlledDeleteFailure(error: unknown, seen = new Set<object>()): boolean {
  if (typeof error === 'string') return error.includes('controlled-session-delete-failure');
  if (!error || typeof error !== 'object' || seen.has(error) || seen.size >= 32) return false;
  seen.add(error);
  const value = error as Record<string, unknown>;
  return ['message', 'originalMessage', 'cause', 'meta', 'driverAdapterError', 'error'].some((key) =>
    isControlledDeleteFailure(value[key], seen),
  );
}

function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}

async function waitForLock(applicationName: string) {
  const deadline = Date.now() + 2000;
  do {
    const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE application_name=${applicationName} AND wait_event_type='Lock' AND state='active') AS waiting`;
    if (rows[0]?.waiting) return;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error('시험 요청이 행 잠금 대기에 도달하지 않았습니다.');
}

afterEach(async () => {
  await db.user.deleteMany({ where: { id: { in: [...users] } } });
  users.clear();
});
afterAll(() => db.$disconnect());

describe('실제 PostgreSQL 계정 토큰 저장과 소비', () => {
  it('무효 후보는 Argon2를 부르지 않고 유효 후보만 실제 해시를 계산한다', async () => {
    const actor = await user();
    const password = randomUUID();
    const spy = vi.spyOn(passwordModule, 'hashPassword');
    try {
      expect(await resetPasswordToken(db, newSession(now).token, password, now)).toBe(false);
      const wrong = (await issueAccountToken(db, actor.id, 'VERIFY_EMAIL', now))!;
      expect(await resetPasswordToken(db, wrong.token, password, now)).toBe(false);
      const expired = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
      expect(await resetPasswordToken(db, expired.token, password, now + 1_800_000)).toBe(false);
      const used = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
      await db.accountToken.update({ where: { id: hashToken(used.token) }, data: { usedAt: new Date(now) } });
      expect(await resetPasswordToken(db, used.token, password, now)).toBe(false);
      const inactive = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
      await db.user.update({ where: { id: actor.id }, data: { status: 'SANCTIONED' } });
      expect(await resetPasswordToken(db, inactive.token, password, now)).toBe(false);
      expect(spy.mock.calls.length).toBe(0);
      await db.user.update({ where: { id: actor.id }, data: { status: 'ACTIVE' } });
      const valid = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
      expect(await resetPasswordToken(db, valid.token, password, now)).toBe(true);
      expect(spy.mock.calls.length).toBe(1);
      expect(
        await verifyPassword((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).passwordHash, password),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
  it('기존 계정은 미인증이며 원문 대신 해시와 용도·만료 시각을 저장한다', async () => {
    const actor = await user();
    expect(actor.emailVerifiedAt).toBeNull();
    const issued = await issueAccountToken(db, actor.id, 'VERIFY_EMAIL', now);
    expect(issued).not.toBeNull();
    const stored = await db.accountToken.findMany({ where: { userId: actor.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: hashToken(issued!.token),
      purpose: 'VERIFY_EMAIL',
      expiresAt: new Date(now + 86_400_000),
      usedAt: null,
    });
    expect(JSON.stringify(stored)).not.toContain(issued!.token);
  });

  it('재발급은 같은 용도만 무효화하고 최신 인증 토큰만 한 번 적용한다', async () => {
    const actor = await user();
    const old = (await issueAccountToken(db, actor.id, 'VERIFY_EMAIL', now))!;
    const reset = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
    const latest = (await issueAccountToken(db, actor.id, 'VERIFY_EMAIL', now + 1))!;
    expect(await verifyEmailToken(db, old.token, now + 2)).toBe(false);
    expect(await verifyEmailToken(db, latest.token, now + 2)).toBe(true);
    expect(await verifyEmailToken(db, latest.token, now + 3)).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).emailVerifiedAt).toEqual(new Date(now + 2));
    expect((await db.accountToken.findUniqueOrThrow({ where: { id: hashToken(reset.token) } })).usedAt).toBeNull();
  });

  it('동시 인증 요청은 한 번만 성공한다', async () => {
    const actor = await user();
    const issued = (await issueAccountToken(db, actor.id, 'VERIFY_EMAIL', now))!;
    const outcomes = await Promise.all([
      verifyEmailToken(db, issued.token, now + 1),
      verifyEmailToken(db, issued.token, now + 1),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await db.accountToken.count({ where: { userId: actor.id, usedAt: { not: null } } })).toBe(1);
  });

  it('만료 경계·다른 용도·잘못된 원문을 거부하고 계정을 바꾸지 않는다', async () => {
    const actor = await user();
    const verify = (await issueAccountToken(db, actor.id, 'VERIFY_EMAIL', now))!;
    const reset = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
    expect(await verifyEmailToken(db, verify.token, now + 86_400_000)).toBe(false);
    expect(await verifyEmailToken(db, reset.token, now + 1)).toBe(false);
    expect(await verifyEmailToken(db, 'invalid', now + 1)).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).emailVerifiedAt).toBeNull();
    expect(await db.accountToken.count({ where: { userId: actor.id, usedAt: { not: null } } })).toBe(0);
  });

  it('동시 재발급 뒤에는 같은 용도의 미사용 토큰이 하나만 남는다', async () => {
    const actor = await user();
    const issued = await Promise.all([
      issueAccountToken(db, actor.id, 'VERIFY_EMAIL', now),
      issueAccountToken(db, actor.id, 'VERIFY_EMAIL', now + 1),
    ]);
    const available = await db.accountToken.findMany({ where: { userId: actor.id, usedAt: null } });
    expect(available).toHaveLength(1);
    const current = issued.find((value) => value && hashToken(value.token) === available[0]!.id)!;
    const previous = issued.find((value) => value !== current)!;
    expect(await verifyEmailToken(db, previous.token, now + 2)).toBe(false);
    expect(await verifyEmailToken(db, current.token, now + 2)).toBe(true);
  });

  it.each(['SANCTIONED', 'WITHDRAWN'] as const)('%s 계정에는 발급·소비하지 않는다', async (status) => {
    const actor = await user();
    const issued = (await issueAccountToken(db, actor.id, 'VERIFY_EMAIL', now))!;
    await db.user.update({ where: { id: actor.id }, data: { status } });
    expect(await issueAccountToken(db, actor.id, 'VERIFY_EMAIL', now + 1)).toBeNull();
    expect(await verifyEmailToken(db, issued.token, now + 1)).toBe(false);
    expect((await db.accountToken.findUniqueOrThrow({ where: { id: hashToken(issued.token) } })).usedAt).toBeNull();
  });

  it('재설정은 비밀번호와 모든 본인 세션만 바꾸고 재사용을 거부한다', async () => {
    const actor = await user(),
      other = await user();
    for (const owner of [actor, actor, other]) {
      const session = newSession(now);
      await db.session.create({ data: { id: session.id, userId: owner.id, expiresAt: session.expiresAt } });
    }
    const issued = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
    const password = randomUUID();
    expect(await resetPasswordToken(db, issued.token, password, now + 1)).toBe(true);
    expect(
      await verifyPassword((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).passwordHash, password),
    ).toBe(true);
    expect(await db.session.count({ where: { userId: actor.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: other.id } })).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).passwordHash).toBe('before-reset');
    expect(await resetPasswordToken(db, issued.token, randomUUID(), now + 2)).toBe(false);
  });

  it('30분 만료 경계의 재설정을 거부하고 비밀번호를 보존한다', async () => {
    const actor = await user();
    const issued = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
    expect(await resetPasswordToken(db, issued.token, randomUUID(), now + 1_800_000)).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).passwordHash).toBe('before-reset');
    expect((await db.accountToken.findUniqueOrThrow({ where: { id: hashToken(issued.token) } })).usedAt).toBeNull();
  });

  it('동시 재설정은 성공한 한 요청의 비밀번호만 저장한다', async () => {
    const actor = await user();
    const issued = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
    const passwords = [randomUUID(), randomUUID()];
    const outcomes = await Promise.all(
      passwords.map((password) => resetPasswordToken(db, issued.token, password, now + 1)),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const stored = await db.user.findUniqueOrThrow({ where: { id: actor.id } });
    expect(await verifyPassword(stored.passwordHash, passwords[outcomes.findIndex(Boolean)]!)).toBe(true);
  });

  it.each([10, 128])('로그인 정책 경계 %i자의 비밀번호로 재설정한다', async (length) => {
    const actor = await user();
    const issued = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
    const password = 'a'.repeat(length);
    expect(await resetPasswordToken(db, issued.token, password, now + 1)).toBe(true);
    expect(
      await verifyPassword((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).passwordHash, password),
    ).toBe(true);
    let logs = '';
    const app = await buildServer({
      db,
      now: () => now + 2,
      logStream: new Writable({
        write(chunk, _encoding, done) {
          logs += String(chunk);
          done();
        },
      }),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/trpc/auth.login?batch=1',
        headers: { origin: 'http://127.0.0.1:5173' },
        payload: { 0: { email: actor.email, password } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()[0].result.data.user.id).toBe(actor.id);
      expect(await db.session.count({ where: { userId: actor.id } })).toBe(1);
      for (const secret of [issued.token, password, actor.email]) expect(logs).not.toContain(secret);
    } finally {
      await app.close();
    }
  });

  it.each([8, 9, 129])('로그인 정책 밖 %i자는 토큰·계정·세션을 바꾸지 않는다', async (length) => {
    const actor = await user();
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId: actor.id, expiresAt: session.expiresAt } });
    const issued = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
    await expect(resetPasswordToken(db, issued.token, 'a'.repeat(length), now + 1)).rejects.toThrow('비밀번호 길이');
    expect((await db.accountToken.findUniqueOrThrow({ where: { id: hashToken(issued.token) } })).usedAt).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).passwordHash).toBe('before-reset');
    expect(await db.session.count({ where: { userId: actor.id } })).toBe(1);
  });

  it('재설정이 먼저 저장되면 이전 비밀번호를 확인한 로그인은 세션을 만들지 않는다', async () => {
    const actor = await user();
    const oldPassword = randomUUID(),
      nextPassword = randomUUID();
    await db.user.update({ where: { id: actor.id }, data: { passwordHash: await hashPassword(oldPassword) } });
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId: actor.id, expiresAt: session.expiresAt } });
    const issued = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
    const suffix = randomUUID().replaceAll('-', '');
    const resetName = `t302_reset_${suffix}`,
      loginName = `t302_login_${suffix}`;
    const resetUrl = new URL(url!),
      loginUrl = new URL(url!);
    resetUrl.searchParams.set('application_name', resetName);
    loginUrl.searchParams.set('application_name', loginName);
    const resetDb = createDb(resetUrl.href),
      loginDb = createDb(loginUrl.href);
    const gate = new Client({ connectionString: url });
    let gateConnected = false;
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    let logs = '';
    const requests: Array<Promise<unknown>> = [],
      failures: unknown[] = [];
    try {
      app = await buildServer({
        db: loginDb,
        now: () => now + 2,
        logStream: new Writable({
          write(chunk, _encoding, done) {
            logs += String(chunk);
            done();
          },
        }),
      });
      await app.ready();
      await gate.connect();
      gateConnected = true;
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [actor.id]);
      const reset = settled(resetPasswordToken(resetDb, issued.token, nextPassword, now + 1));
      requests.push(reset);
      // 재설정을 먼저 대기시키고 이전 비밀번호의 실제 HTTP 로그인을 같은 행 잠금 뒤에 대기시킨다.
      await waitForLock(resetName);
      const login = settled(
        app.inject({
          method: 'POST',
          url: '/trpc/auth.login?batch=1',
          headers: { origin: 'http://127.0.0.1:5173' },
          payload: { 0: { email: actor.email, password: oldPassword } },
        }),
      );
      requests.push(login);
      await waitForLock(loginName);
      await gate.query('COMMIT');
      const resetResult = await reset,
        loginResult = await login;
      if (resetResult.status === 'rejected') throw resetResult.reason;
      if (loginResult.status === 'rejected') throw loginResult.reason;
      expect(resetResult.value).toBe(true);
      expect(loginResult.value.statusCode).toBe(401);
      expect(loginResult.value.json()[0].error.data.code).toBe('UNAUTHORIZED');
      expect(await db.session.count({ where: { userId: actor.id } })).toBe(0);
      expect(
        await verifyPassword((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).passwordHash, nextPassword),
      ).toBe(true);
      for (const secret of [issued.token, oldPassword, nextPassword, actor.email]) expect(logs).not.toContain(secret);
    } catch (error) {
      failures.push(error);
    } finally {
      if (gateConnected) {
        try {
          await gate.query('ROLLBACK');
        } catch (error) {
          failures.push(error);
        }
      }
      await Promise.all(requests);
      for (const result of await Promise.allSettled([
        app?.close(),
        gate.end(),
        resetDb.$disconnect(),
        loginDb.$disconnect(),
      ])) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    }
    if (failures.length) throw new AggregateError(failures, '로그인·재설정 경합 검사 또는 정리에 실패했습니다.');
  });

  it('세션 삭제가 실패하면 토큰 소비와 비밀번호 변경도 롤백한다', async () => {
    const actor = await user();
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId: actor.id, expiresAt: session.expiresAt } });
    const issued = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
    const name = `t302_${randomUUID().replaceAll('-', '')}`;
    // 식별자는 직접 만든 소문자16진수, 비교값은 생성한 SHA-256만 쓴다.
    expect(name).toMatch(/^t302_[0-9a-f]{32}$/);
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    await db.$executeRawUnsafe(
      `CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${session.id}' THEN RAISE EXCEPTION 'controlled-session-delete-failure'; END IF; RETURN OLD; END $$`,
    );
    try {
      await db.$executeRawUnsafe(
        `CREATE TRIGGER "${name}" BEFORE DELETE ON "Session" FOR EACH ROW EXECUTE FUNCTION "${name}"()`,
      );
      let failure: unknown;
      try {
        await resetPasswordToken(db, issued.token, randomUUID(), now + 1);
      } catch (error) {
        failure = error;
      }
      expect(isControlledDeleteFailure(failure)).toBe(true);
      expect((await db.accountToken.findUniqueOrThrow({ where: { id: hashToken(issued.token) } })).usedAt).toBeNull();
      expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).passwordHash).toBe('before-reset');
      expect(await db.session.count({ where: { userId: actor.id } })).toBe(1);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON "Session"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${name}"()`);
    }
  });
});
