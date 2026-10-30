import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { buildServer } from '../apps/server/src/server';
import { appRouter } from '../apps/server/src/router';
import type { ProcedureMeta } from '../apps/server/src/trpc';
import type { MailMessage } from '../apps/server/src/mail/transport';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)
)
  throw new Error('loopback 전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = Date.now();
const origin = 'http://127.0.0.1:5173';
const mail: MailMessage[] = [];
const app = await buildServer({
  db,
  logging: false,
  now: () => now,
  publicOrigin: origin,
  emailVerificationRequired: true,
  mailTransport: {
    async send(message) {
      mail.push(message);
    },
  },
});
const users: string[] = [],
  worlds: string[] = [];
const cookies: string[] = [];
let address: string, passwordHash: string;
const password = randomUUID();
const executions = new Set<Promise<unknown>>();
function track<T>(action: () => Promise<T>): Promise<T> {
  const execution = Promise.resolve().then(action);
  executions.add(execution);
  void execution.finally(() => executions.delete(execution)).catch(() => undefined);
  return execution;
}
function it(name: string, action: () => Promise<void>) {
  test(name, () => track(action));
}
async function settleExecutions() {
  while (executions.size > 0) await Promise.allSettled([...executions]);
}
beforeEach(async () => {
  await settleExecutions();
});
const procedures = appRouter._def.procedures as unknown as Record<
  string,
  { _def: { type: string; meta?: ProcedureMeta } }
>;
const paths = Object.entries(procedures)
  .filter(([, value]) => value._def.type === 'mutation' && value._def.meta?.accountAccess === 'verified')
  .map(([path]) => path)
  .sort();

async function request(path: string, input: unknown, cookie?: string, mutation = true) {
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${address}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const [body] = (await response.json()) as Array<{
    result?: {
      data: {
        user: { id: string; email: string } | null;
        emailVerified: boolean;
        status: string;
        general: { id: number };
        ok: boolean;
        revision: number;
      };
    };
    error?: { data: { reason: string | null; code: string } };
  }>;
  if (!body) throw new Error('HTTP 응답이 없습니다.');
  return {
    status: response.status,
    data: body.result?.data,
    error: body.error,
    cookie: response.headers
      .getSetCookie()
      .find((value) => value.startsWith('sid='))
      ?.split(';')[0],
  };
}

async function snapshot() {
  return db.$transaction(
    async (tx) => {
      const tables = await tx.$queryRaw<
        Array<{ tablename: string }>
      >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
      const result: Record<string, unknown> = {};
      for (const { tablename } of tables) {
        if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(tablename)) throw new Error('검사 테이블 이름을 확인하세요.');
        const rows = await tx.$queryRawUnsafe<Array<{ rows: unknown }>>(
          `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM "${tablename}" t`,
        );
        result[tablename] = rows[0]!.rows;
      }
      return hashState(result);
    },
    { isolationLevel: 'RepeatableRead' },
  );
}

beforeAll(async () => {
  passwordHash = await hashPassword(password);
  for (const status of ['ACTIVE', 'ACTIVE', 'SANCTIONED'] as const) {
    const user = await db.user.create({
      data: {
        email: `${randomUUID()}@example.invalid`,
        passwordHash,
        status,
        ...(users.length === 1 ? { emailVerifiedAt: new Date(now) } : {}),
      },
    });
    users.push(user.id);
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
    cookies.push(`sid=${session.token}`);
  }
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await settleExecutions();
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe('T3-02 AC-M3-01 실제 PostgreSQL·HTTP 이메일 인증 차단', () => {
  it('실제 운영 서버 생성은 끄기 설정과 개발 모드 위장을 거부한다', async () => {
    const environment = { node: process.env.NODE_ENV, required: process.env.EMAIL_VERIFICATION_REQUIRED };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.EMAIL_VERIFICATION_REQUIRED;
      await expect(buildServer({ db, production: false, logging: false })).rejects.toThrow('꺼둘 수 없습니다');
      await expect(buildServer({ db, emailVerificationRequired: false, logging: false })).rejects.toThrow(
        '꺼둘 수 없습니다',
      );
      process.env.EMAIL_VERIFICATION_REQUIRED = '0';
      await expect(buildServer({ db, logging: false })).rejects.toThrow('꺼둘 수 없습니다');
    } finally {
      if (environment.node === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = environment.node;
      if (environment.required === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
      else process.env.EMAIL_VERIFICATION_REQUIRED = environment.required;
    }
  });

  it('계정 조회는 차단 여부를 알리고 기존 세션 응답 계약은 보존한다', async () => {
    expect((await request('account.get', undefined, cookies[0], false)).data).toMatchObject({
      emailVerificationRequired: true,
      emailVerified: false,
    });
    expect((await request('auth.me', undefined, cookies[0], false)).data!.user!).toEqual({
      id: users[0],
      email: (await db.user.findUniqueOrThrow({ where: { id: users[0]! } })).email,
      emailVerified: false,
      consentRequired: [],
    });
  });

  it('30개 변경 API가 미인증·위조·무인증·제재를 거부하며 모든 DB 행은 그대로다', async () => {
    expect(paths).toHaveLength(30);
    expect(paths).toContain('admin.world.requestClock');
    expect(paths).toContain('admin.world.create');
    expect(paths).toContain('cityResources.allocate');
    expect(paths).toContain('admin.world.requestEnd');
    expect(paths).toContain('admin.world.requestReset');
    const before = await snapshot();
    for (const path of paths) {
      for (const input of [
        {},
        { emailVerified: true, emailVerifiedAt: new Date(now).toISOString(), userId: users[1] },
      ]) {
        const response = await request(path, input, cookies[0]);
        expect(response.status, path).toBe(403);
        expect(response.error!.data, path).toMatchObject({ code: 'FORBIDDEN', reason: 'EMAIL_NOT_VERIFIED' });
      }
      for (const cookie of [undefined, cookies[2]]) {
        const response = await request(path, {}, cookie);
        expect(response.status, path).toBe(401);
        expect(response.error!.data, path).toMatchObject({ code: 'UNAUTHORIZED', reason: null });
      }
      const verified = await request(path, {}, cookies[1]);
      expect(verified.status, path).toBe(path.startsWith('admin.') ? 403 : 400);
      expect(verified.error!.data, path).toMatchObject({
        code: path.startsWith('admin.') ? 'FORBIDDEN' : 'BAD_REQUEST',
        reason: null,
      });
    }
    expect(await snapshot()).toBe(before);
  });

  it('미인증 상태에서도 가입·로그인·메일 재전송·인증·암호 복구·로그아웃은 이어진다', async () => {
    const email = `${randomUUID()}@example.invalid`;
    const signup = await request('auth.signup', { email, password });
    expect(signup.status).toBe(200);
    users.push(signup.data!.user!.id);
    const login = await request('auth.login', { email, password });
    expect(login.status).toBe(200);
    const cookie = login.cookie!;
    const resend = await request('account.resendVerification', undefined, cookie);
    expect(resend.status).toBe(200);
    const verifyMail = mail.at(-1)!;
    const verifyUrl = verifyMail.text.match(/http:\/\/[^\s]+/)?.[0];
    expect(verifyUrl).toBeTruthy();
    const token = new URLSearchParams(new URL(verifyUrl!).hash.slice(1)).get('token');
    expect((await request('account.verifyEmail', { token })).status).toBe(200);
    expect((await request('account.get', undefined, cookie, false)).data!.emailVerified).toBe(true);
    expect((await request('account.requestPasswordReset', { email })).status).toBe(200);
    const resetUrl = mail.at(-1)!.text.match(/http:\/\/[^\s]+/)?.[0];
    const reset = await request('account.resetPassword', {
      token: new URLSearchParams(new URL(resetUrl!).hash.slice(1)).get('token'),
      password: password + '!',
    });
    expect(reset.status).toBe(200);
    expect((await request('auth.me', undefined, cookie, false)).data!.user!).toBeNull();
    const relogin = await request('auth.login', { email, password: password + '!' });
    expect(relogin.status).toBe(200);
    expect((await request('auth.logout', undefined, relogin.cookie)).data).toEqual({ ok: true });
  });

  it('인증한 세션은 정식 191년 491명 월드에서 장수 생성과 30칸 예약을 실행한다', async () => {
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'public-verification-http-191',
    });
    initial.ruleFeatures = [
      'campaign-v1',
      'five-stats',
      'operational-map',
      'personnel',
      'policy',
      'stratagem-basic',
      'treaty',
    ];
    expect(initial.generals).toHaveLength(491);
    expect(initial.nations).toHaveLength(21);
    const saved = await saveInitialWorld(db, initial, { name: '공개 인증 정식191', turnTermMinutes: 60, endYear: 201 });
    worlds.push(saved.worldId);
    const worldId = saved.worldId;
    await controlClock(db, worldId, 'start');
    const creating = track(() =>
      request(
        'general.create',
        {
          worldId,
          name: '인증장수',
          portraitId: null,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
        },
        cookies[1],
      ),
    );
    await expect
      .poll(() =>
        db.inputEvent.count({ where: { worldId, userId: users[1]!, kind: 'general.create', status: 'PENDING' } }),
      )
      .toBe(1);
    const lease = await acquireLease(db, worldId);
    expect(lease).not.toBeNull();
    try {
      await new TurnLoop(db, lease!).advanceTo(0);
    } finally {
      await releaseLease(db, lease!);
    }
    const created = await creating;
    expect(created.status).toBe(200);
    expect(created.data!.status).toBe('created');
    expect(await db.general.count({ where: { worldId, userId: null } })).toBe(491);
    const slots = Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {} }));
    const reservation = await request('turns.set', { worldId, revision: 0, slots }, cookies[1]);
    expect(reservation.status).toBe(200);
    expect(reservation.data).toMatchObject({ ok: true, revision: 1 });
    expect(await db.generalTurn.count({ where: { worldId, generalId: created.data!.general.id } })).toBe(30);
    const before = await snapshot();
    const blocked = await request('turns.set', { worldId, revision: 1, slots, userId: users[1] }, cookies[0]);
    expect(blocked.error!.data.reason).toBe('EMAIL_NOT_VERIFIED');
    expect(await snapshot()).toBe(before);
  });
});
