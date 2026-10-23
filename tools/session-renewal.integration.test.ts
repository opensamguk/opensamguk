import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { hashPassword } from '../apps/server/src/auth/password';
import { hashToken, newSession, SESSION_RENEW_MS, SESSION_SECONDS } from '../apps/server/src/auth/session';
import { displaySlots } from '../apps/server/src/game/slots';
import { readFixture } from '../apps/server/test/readFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';

const sourceUrl = process.env.TEST_DATABASE_URL;
if (!sourceUrl || !/^[a-z][a-z0-9_]*_test$/.test(new URL(sourceUrl).pathname.slice(1)))
  throw new Error('전용 테스트 DB가 필요합니다.');
// 장애 주입은 이 파일이 새로 만든 DB에만 적용한다. 원래 시험 DB의 테이블은 건드리지 않는다.
const databaseName = `session_renewal_${randomUUID().replaceAll('-', '')}_test`;
const databaseUrl = new URL(sourceUrl);
databaseUrl.pathname = `/${databaseName}`;
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = '/postgres';
const admin = createDb(adminUrl.href);
const db = createDb(databaseUrl.href);
const origin = 'https://game.example.test';
const now = 1_800_000_000_001;
const expiresAt = new Date(now + 120_000);
const warning = '세션 갱신 실패';
const canary = 'SESSION_RENEWAL_DB_CANARY';
const slots = Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {} }));
let databaseCreated = false;
let passwordHash: string;
let user: { id: string; email: string };
let worldId: string;
let token: string;
let sessionId: string;
let logText = '';
const logStream = new Writable({
  write(chunk, _encoding, done) {
    logText += String(chunk);
    done();
  },
});

type Envelope = { result?: { data: unknown }; error?: { data: { code: string } } };
async function send(base: string, path = 'turns.set', body: unknown = mutation(), cookie = token) {
  const response = await fetch(`${base}/trpc/${path}?batch=1`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', cookie: `sid=${cookie}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, cookie: response.headers.get('set-cookie'), body: await response.json() };
}
const mutation = (revision = 0) => ({ 0: { worldId, revision, slots } });
const success = (revision = 1) => [{ result: { data: { ok: true, revision, slots: displaySlots(slots) } } }];
async function businessSnapshot() {
  return {
    general: await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: user.id } } }),
    turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    events: await db.inputEvent.findMany({ where: { worldId }, orderBy: { sequence: 'asc' } }),
  };
}
async function sessionExpiry() {
  return (await db.session.findUniqueOrThrow({ where: { id: sessionId } })).expiresAt;
}
async function withServer(fn: (base: string) => Promise<void>) {
  const app = await buildServer({ db, publicOrigin: origin, production: true, now: () => now, logStream });
  try {
    await fn(await app.listen({ host: '127.0.0.1', port: 0 }));
  } finally {
    await app.close();
  }
}
async function restoreFault() {
  await db.$executeRawUnsafe('ALTER TABLE IF EXISTS "session_renewal_hidden" RENAME TO "Session"');
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS session_renewal_fault ON "Session"');
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS session_renewal_fault ON "InputEvent"');
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS session_renewal_fault()');
  await db.$executeRawUnsafe('DROP SEQUENCE IF EXISTS session_renewal_attempts');
}
async function withFault(mode: 'update' | 'read', fn: () => Promise<void>) {
  try {
    await db.$executeRawUnsafe('CREATE SEQUENCE session_renewal_attempts');
    if (mode === 'update') {
      await db.$executeRawUnsafe(`CREATE FUNCTION session_renewal_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM nextval('session_renewal_attempts');
          RAISE EXCEPTION '${canary}';
        END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER session_renewal_fault BEFORE UPDATE OF "expiresAt" ON "Session"
        FOR EACH ROW EXECUTE FUNCTION session_renewal_fault()`);
    } else {
      // InputEvent INSERT와 같은 트랜잭션에서 이름을 바꾼다. 커밋 뒤 onSend의 실제 SELECT만 실패한다.
      await db.$executeRawUnsafe(`CREATE FUNCTION session_renewal_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM nextval('session_renewal_attempts');
          ALTER TABLE "Session" RENAME TO "session_renewal_hidden";
          RETURN NEW;
        END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER session_renewal_fault AFTER INSERT ON "InputEvent"
        FOR EACH ROW EXECUTE FUNCTION session_renewal_fault()`);
    }
    await fn();
  } finally {
    await restoreFault();
  }
}
async function faultAttempts() {
  const [row] = await db.$queryRaw<{ count: number }[]>`
    SELECT CASE WHEN is_called THEN last_value::int ELSE 0 END AS count FROM session_renewal_attempts`;
  return row!.count;
}
function safeWarnings(count: number) {
  const entries: Record<string, unknown>[] = logText
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const warnings = entries.filter((entry) => entry.msg === warning);
  expect(warnings).toHaveLength(count);
  for (const entry of warnings) {
    expect(entry.level).toBe(40);
    expect(Object.keys(entry).sort()).toEqual(['hostname', 'level', 'msg', 'pid', 'time']);
  }
  for (const secret of [
    token,
    sessionId,
    user.email,
    user.id,
    passwordHash,
    sourceUrl!,
    canary,
    'session_renewal_hidden',
  ])
    expect(logText.includes(secret)).toBe(false);
}

beforeAll(async () => {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  const result = spawnSync('pnpm', ['--filter', '@opensamguk/db', 'migrate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl.href },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) throw new Error('세션 갱신 시험 DB migration에 실패했습니다.');
  passwordHash = await hashPassword(randomUUID());
  console.log(
    'SESSION_RENEWAL_FAULT_SCOPE isolated file-owned PostgreSQL DB; real loopback HTTP; no mock/syscall fault',
  );
}, 90_000);
beforeEach(async () => {
  logText = '';
  user = await db.user.create({
    data: { email: `${randomUUID()}@example.test`, passwordHash },
    select: { id: true, email: true },
  });
  const state = await readFixture();
  state.generals[0]!.userId = user.id;
  ({ worldId } = await saveInitialWorld(db, state, { name: '세션 갱신 시험', turnTermMinutes: 60, endYear: null }));
  const session = newSession(now);
  token = session.token;
  sessionId = session.id;
  await db.session.create({ data: { id: sessionId, userId: user.id, expiresAt } });
});
afterEach(async () => {
  await restoreFault();
  if (worldId) await db.world.deleteMany({ where: { id: worldId } });
  if (user) await db.user.deleteMany({ where: { id: user.id } });
});
afterAll(async () => {
  try {
    await db.$disconnect();
    if (databaseCreated) await admin.$executeRawUnsafe(`DROP DATABASE "${databaseName}"`);
  } finally {
    await admin.$disconnect();
  }
});

describe('T3-04 세션 갱신 장애와 실제 HTTP·PostgreSQL 커밋', () => {
  it.each(['update', 'read'] as const)(
    '%s 장애 뒤에도 원200·payload·커밋1회를 보존하고 같은 revision 재전송은 STALE이다',
    async (mode) => {
      await withServer(async (base) => {
        const before = await businessSnapshot();
        await withFault(mode, async () => {
          const response = await send(base);
          const committed = await businessSnapshot();
          expect(committed.general.turnRevision).toBe(before.general.turnRevision + 1);
          expect(committed.events).toHaveLength(before.events.length + 1);
          expect(committed.events.at(-1)).toMatchObject({
            kind: 'turns.set',
            status: 'APPLIED',
            result: { revision: 1 },
          });
          expect(committed.turns.filter((turn) => turn.generalId === committed.general.id)).toEqual(
            slots.map((slot, index) => expect.objectContaining({ slot: index, ...slot })),
          );
          expect(await faultAttempts()).toBe(1);
          console.log(`SESSION_RENEWAL_COMMIT ${mode}: business revision+1/InputEvent+1; real PG fault reached`);
          expect(response.cookie).toBeNull();
          expect(response.status).toBe(200);
          expect(response.body).toEqual(success());
        });
        expect(await sessionExpiry()).toEqual(expiresAt);
        safeWarnings(1);
        const committed = await businessSnapshot();
        // 재전송에서도 갱신 장애를 유지해 DB·쿠키가 연장되지 않는지 확인한다.
        await withFault('update', async () => {
          const retry = await send(base);
          expect(retry.status).toBe(200);
          expect(retry.body).toEqual([
            { result: { data: { ok: false, reason: 'STALE', revision: 1, slots: displaySlots(slots) } } },
          ]);
          expect(retry.cookie).toBeNull();
          expect(await businessSnapshot()).toEqual(committed);
          expect(await faultAttempts()).toBe(1);
        });
        expect(await sessionExpiry()).toEqual(expiresAt);
        safeWarnings(2);
      });
    },
  );

  it('인증 단계의 실제 SELECT 오류는500이며 handler와 선택 갱신을 실행하지 않는다', async () => {
    await withServer(async (base) => {
      const before = await businessSnapshot();
      try {
        await db.$executeRawUnsafe('ALTER TABLE "Session" RENAME TO "session_renewal_hidden"');
        const response = await send(base);
        expect(response.status).toBe(500);
        expect(response.cookie).toBeNull();
        expect(await businessSnapshot()).toEqual(before);
        safeWarnings(0);
      } finally {
        await restoreFault();
      }
      expect(await sessionExpiry()).toEqual(expiresAt);
    });
  });

  it('정상 갱신과 동시 요청은30일 DB 연장·Secure 쿠키를 정확히1회 남긴다', async () => {
    await withServer(async (base) => {
      await db.$executeRawUnsafe('CREATE SEQUENCE session_renewal_attempts');
      await db.$executeRawUnsafe(`CREATE FUNCTION session_renewal_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM nextval('session_renewal_attempts'); RETURN NEW; END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER session_renewal_fault AFTER UPDATE OF "expiresAt" ON "Session"
        FOR EACH ROW EXECUTE FUNCTION session_renewal_fault()`);
      try {
        const reads = await Promise.all(
          Array.from({ length: 6 }, () => fetch(`${base}/trpc/auth.me`, { headers: { cookie: `sid=${token}` } })),
        );
        for (const response of reads) {
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ result: { data: { user } } });
        }
        const cookies = reads.map((response) => response.headers.get('set-cookie')).filter((value) => value !== null);
        expect(cookies).toHaveLength(1);
        for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_SECONDS}`])
          expect(cookies[0]!.includes(part)).toBe(true);
        expect(cookies[0]!.startsWith(`sid=${token};`)).toBe(true);
        expect(await sessionExpiry()).toEqual(new Date(now + SESSION_SECONDS * 1000));
        expect(await faultAttempts()).toBe(1);
        safeWarnings(0);
      } finally {
        await restoreFault();
      }
    });
  });

  it.each(['expired', 'sanctioned', 'invalidInput', 'mixed207', 'rateLimited'] as const)(
    '%s는 갱신하지 않고 기존 거부·207 정책을 유지한다',
    async (mode) => {
      await withServer(async (base) => {
        if (mode === 'expired')
          await db.session.update({ where: { id: sessionId }, data: { expiresAt: new Date(now) } });
        if (mode === 'sanctioned') await db.user.update({ where: { id: user.id }, data: { status: 'SANCTIONED' } });
        if (mode === 'rateLimited') {
          for (let i = 0; i < 120; i++) {
            const response = await send(base, 'turns.set', mutation(i));
            expect(response.status).toBe(200);
          }
          await db.session.update({ where: { id: sessionId }, data: { expiresAt } });
        }
        const before = await businessSnapshot();
        const expiry = await sessionExpiry();
        await withFault('update', async () => {
          const response =
            mode === 'mixed207'
              ? await send(base, 'turns.set,turns.set', { ...mutation(), 1: { worldId, revision: -1, slots } })
              : await send(base, 'turns.set', mode === 'invalidInput' ? mutation(-1) : mutation());
          expect(response.status).toBe(
            mode === 'mixed207' ? 207 : mode === 'invalidInput' ? 400 : mode === 'rateLimited' ? 429 : 401,
          );
          expect(response.cookie).toBeNull();
          expect(await faultAttempts()).toBe(0);
          expect(await sessionExpiry()).toEqual(expiry);
          if (mode === 'mixed207') {
            const envelopes = response.body as Envelope[];
            expect(envelopes[0]).toEqual(success()[0]);
            expect(envelopes[1]?.error?.data.code).toBe('BAD_REQUEST');
            const after = await businessSnapshot();
            expect(after.general.turnRevision).toBe(before.general.turnRevision + 1);
            expect(after.events).toHaveLength(before.events.length + 1);
          } else expect(await businessSnapshot()).toEqual(before);
          safeWarnings(0);
        });
      });
    },
  );

  it('갱신 대상이 아닌 세션은 DB UPDATE와 경고를 남기지 않는다', async () => {
    await db.session.update({ where: { id: sessionId }, data: { expiresAt: new Date(now + SESSION_RENEW_MS + 1) } });
    await withServer(async (base) => {
      await withFault('update', async () => {
        const response = await send(base);
        expect(response.status).toBe(200);
        expect(response.body).toEqual(success());
        expect(response.cookie).toBeNull();
        expect(await faultAttempts()).toBe(0);
        expect(await sessionExpiry()).toEqual(new Date(now + SESSION_RENEW_MS + 1));
        safeWarnings(0);
      });
    });
  });

  it('로그인은 새sid를 설정하고 로그아웃은 삭제 쿠키를 유지한다', async () => {
    const password = randomUUID();
    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
    await withServer(async (base) => {
      const login = await send(base, 'auth.login', { 0: { email: user.email, password } });
      expect(login.status).toBe(200);
      expect(await db.session.findUnique({ where: { id: sessionId } })).toBeNull();
      const newToken = login.cookie?.match(/^sid=([^;]+);/)?.[1];
      expect(newToken !== undefined && newToken !== token).toBe(true);
      expect(login.cookie?.includes('Secure')).toBe(true);
      const loggedIn = await db.session.findUniqueOrThrow({ where: { id: hashToken(newToken!) } });
      expect(loggedIn.expiresAt).toEqual(new Date(now + SESSION_SECONDS * 1000));
      const logout = await send(base, 'auth.logout', {}, newToken!);
      expect(logout.status).toBe(200);
      expect(logout.cookie?.startsWith('sid=;')).toBe(true);
      expect(logout.cookie?.includes('Max-Age=0')).toBe(true);
      expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
      expect(logText.includes(password)).toBe(false);
      expect(logText.includes(newToken!)).toBe(false);
      safeWarnings(0);
    });
  });
});
