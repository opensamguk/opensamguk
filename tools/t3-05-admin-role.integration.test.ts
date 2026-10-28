import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { changeAdminRole } from '../apps/server/src/admin/roleStore';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { testDatabaseUrl } from './test-database';

if (!process.env.TEST_DATABASE_URL) throw new Error('전용 테스트 DB가 필요합니다.');
const target = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['localhost', '127.0.0.1'].includes(target.hostname)) throw new Error('loopback 전용 테스트 DB가 필요합니다.');
const url = target.href;
const db = createDb(url);
const now = Date.now();
const origin = 'http://127.0.0.1:5173';
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
const users: string[] = [];
const executions = new Set<Promise<unknown>>();
const executionErrors: unknown[] = [];
let base: string;

function track<T>(action: () => Promise<T>) {
  const execution = Promise.resolve().then(action);
  executions.add(execution);
  void execution.then(
    () => executions.delete(execution),
    (error: unknown) => {
      executionErrors.push(error);
      executions.delete(execution);
    },
  );
  return execution;
}
function it(name: string, action: () => Promise<void>) {
  test(name, () => track(action));
}
async function settleExecutions() {
  while (executions.size) await Promise.allSettled([...executions]);
}
beforeEach(settleExecutions);

async function user(
  role: 'USER' | 'ADMIN' = 'USER',
  status: 'ACTIVE' | 'SANCTIONED' | 'WITHDRAWN' = 'ACTIVE',
  verified = true,
) {
  const actor = await db.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      passwordHash: 'not-used-for-login',
      role,
      status,
      emailVerifiedAt: verified ? new Date(now) : null,
    },
  });
  users.push(actor.id);
  return actor;
}
async function cookie(userId: string) {
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId, expiresAt: session.expiresAt } });
  return `sid=${session.token}`;
}
async function snapshot() {
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const hash = createHash('sha256');
  for (const { tablename } of tables) {
    const name = '"' + tablename.replaceAll('"', '""') + '"';
    const rows = await db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${name} t`,
    );
    hash.update(tablename + '\n' + rows[0]!.body + '\n');
  }
  return hash.digest('hex');
}
async function request(sid?: string, input?: unknown) {
  const response = await fetch(
    `${base}/trpc/admin.whoami?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`,
    { headers: { origin, ...(sid ? { cookie: sid } : {}) }, signal: AbortSignal.timeout(5000) },
  );
  const [body] = (await response.json()) as Array<{
    result?: { data: unknown };
    error?: { data: { code: string; reason: string | null } };
  }>;
  return {
    status: response.status,
    data: body!.result?.data,
    code: body!.error?.data.code,
    reason: body!.error?.data.reason,
  };
}
async function cli(args: string[], body: string, database = url) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./admin-role.ts', import.meta.url)), ...args],
    { env: { ...process.env, DATABASE_URL: database }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let error: Error | undefined;
    child.once('error', (value) => {
      error = value;
    });
    child.once('close', (code) => (error ? reject(error) : resolve({ code, stdout, stderr })));
  });
  executions.add(done);
  void done.then(
    () => executions.delete(done),
    () => executions.delete(done),
  );
  child.stdin.on('error', () => {});
  child.stdin.end(body);
  return done;
}

beforeAll(() =>
  track(async () => {
    app = await buildServer({
      db,
      now: () => now,
      logging: false,
      publicOrigin: origin,
      emailVerificationRequired: true,
    });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  }),
);
afterAll(async () => {
  await settleExecutions();
  const errors = [...executionErrors];
  for (const action of [
    () => app?.close(),
    () => db.user.deleteMany({ where: { id: { in: users } } }),
    () => db.$disconnect(),
  ]) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError([...new Set(errors)], '관리자 시험 실행·정리 실패');
});

describe('T3-05 AC-M3-04 실제 관리자 권한과 추가 전용 감사', () => {
  for (const category of categories)
    it(
      `admin.whoami ${category}`,
      authzCase('admin.whoami', category, async () => {
        const actor = await user(
          category === 'otherUser' ? 'USER' : 'ADMIN',
          category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE',
        );
        const sid = category === 'unauthenticated' ? undefined : await cookie(actor.id);
        const before = await snapshot();
        const result = await request(
          sid,
          category === 'invalidInput' ? { role: 'ADMIN', userId: actor.id } : undefined,
        );
        if (category === 'success') expect(result).toMatchObject({ status: 200, data: { admin: true } });
        else
          expect(result.code).toBe(
            category === 'otherUser' ? 'FORBIDDEN' : category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED',
          );
        expect(await snapshot()).toBe(before);
      }),
    );

  it('기본 USER·필수 인증·위조 역할과 기존 세션의 즉시 회수를 확인한다', async () => {
    const actor = await user();
    expect(actor.role).toBe('USER');
    const sid = await cookie(actor.id);
    const before = await snapshot();
    expect((await request(sid, { role: 'ADMIN' })).code).toBe('FORBIDDEN');
    expect(await snapshot()).toBe(before);
    await changeAdminRole(db, { email: actor.email, reason: '전용 시험 부여', role: 'ADMIN' });
    expect((await request(sid)).data).toEqual({ admin: true });
    await changeAdminRole(db, { email: actor.email, reason: '전용 시험 회수', role: 'USER' });
    expect((await request(sid)).code).toBe('FORBIDDEN');
    const unverified = await user('ADMIN', 'ACTIVE', false);
    expect(await request(await cookie(unverified.id))).toMatchObject({ status: 403, reason: 'EMAIL_NOT_VERIFIED' });
  });

  it('실제 CLI 표준 입력의 부여·재요청·회수와 출력·감사를 확인한다', async () => {
    const actor = await user();
    for (const [command, role, changed] of [
      ['grant', 'ADMIN', true],
      ['grant', 'ADMIN', false],
      ['revoke', 'USER', true],
    ] as const) {
      const result = await cli(
        [command],
        JSON.stringify({ email: ` ${actor.email.toUpperCase()} `, reason: '전용 명령 시험' }),
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.includes(actor.email)).toBe(false);
      expect(result.stdout.includes(actor.passwordHash)).toBe(false);
      const output = JSON.parse(result.stdout) as { auditId: string };
      expect(output).toEqual({ userId: actor.id, role, changed, auditId: expect.stringMatching(/^\d+$/) });
      expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).role).toBe(role);
      const audit = await db.auditLog.findUniqueOrThrow({ where: { id: BigInt(output.auditId) } });
      expect(audit).toMatchObject({
        actorKind: 'CLI',
        action: command === 'grant' ? 'admin.grant' : 'admin.revoke',
        actorUserId: null,
        targetType: 'User',
        targetId: actor.id,
        worldId: null,
        inputEventId: null,
        reason: '전용 명령 시험',
        payload: { afterRole: role, changed },
      });
      expect(JSON.stringify(audit.payload).includes(actor.email)).toBe(false);
      expect(audit.at.getTime()).toBeGreaterThan(now - 1000);
    }
    expect(await db.auditLog.count({ where: { targetId: actor.id } })).toBe(3);
  });

  const invalidCases = [
    { args: [], body: '{}' },
    { args: ['grant', 'extra'], body: '{}' },
    { args: ['other'], body: '{}' },
    { args: ['grant'], body: 'invalid-json' },
    { args: ['grant'], body: 'x'.repeat(4097) },
    { args: ['grant'], body: JSON.stringify({ email: 'invalid', reason: '시험' }) },
    { args: ['grant'], body: JSON.stringify({ email: 'missing@example.test', reason: '' }) },
    { args: ['grant'], body: JSON.stringify({ email: 'missing@example.test', reason: 'x'.repeat(201) }) },
    { args: ['grant'], body: JSON.stringify({ email: 'missing@example.test', reason: '시험', role: 'ADMIN' }) },
  ];
  for (const [index, input] of invalidCases.entries())
    it(`실제 CLI 입력 오류 ${index + 1}은 DB를 바꾸지 않는다`, async () => {
      const before = await snapshot();
      const result = await cli(input.args, input.body);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('관리자 권한을 변경하지 못했습니다. 명령·표준 입력·대상 계정·DB 설정을 확인하세요.\n');
      expect(await snapshot()).toBe(before);
    });

  for (const status of ['SANCTIONED', 'WITHDRAWN'] as const)
    it(`${status} 계정은 실제 CLI로 권한을 받지 않는다`, async () => {
      const actor = await user('USER', status);
      const before = await snapshot();
      expect((await cli(['grant'], JSON.stringify({ email: actor.email, reason: '전용 거부 시험' }))).code).toBe(1);
      expect(await snapshot()).toBe(before);
    });
  it('없는 계정은 역할·감사 행을 만들지 않는다', async () => {
    const before = await snapshot();
    expect(
      (await cli(['grant'], JSON.stringify({ email: `${randomUUID()}@example.test`, reason: '전용 거부 시험' }))).code,
    ).toBe(1);
    expect(await snapshot()).toBe(before);
  });

  it('동시 부여·회수는 같은 사용자 잠금 아래 감사 전후 역할이 이어진다', async () => {
    const actor = await user();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        changeAdminRole(db, { email: actor.email, reason: '동시 전용 시험', role: index % 2 ? 'USER' : 'ADMIN' }),
      ),
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        '동시 역할 변경 실패',
      );
    const logs = await db.auditLog.findMany({ where: { targetId: actor.id }, orderBy: { id: 'asc' } });
    expect(logs).toHaveLength(8);
    let previous = 'USER';
    for (const log of logs) {
      const payload = log.payload as { beforeRole: string; afterRole: string; changed: boolean };
      expect(payload.beforeRole).toBe(previous);
      expect(payload.changed).toBe(payload.beforeRole !== payload.afterRole);
      previous = payload.afterRole;
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).role).toBe(previous);
  });

  it('실제 DB 감사 쓰기 실패는 역할 변경도 롤백한다', async () => {
    const actor = await user();
    const name = 't305_' + randomUUID().replaceAll('-', '');
    await db.$executeRawUnsafe(
      `CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled-audit-failure'; END; $$`,
    );
    try {
      await db.$executeRawUnsafe(
        `CREATE TRIGGER "${name}" BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."targetId" = '${actor.id}') EXECUTE FUNCTION "${name}"()`,
      );
      await expect(
        changeAdminRole(db, { email: actor.email, reason: '전용 실패 시험', role: 'ADMIN' }),
      ).rejects.toThrow();
      expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).role).toBe('USER');
      expect(await db.auditLog.count({ where: { targetId: actor.id } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON "AuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${name}"()`);
    }
  });

  it('실제 UPDATE·DELETE·TRUNCATE가 거부되고 감사 원장이 그대로 남는다', async () => {
    const actor = await user();
    const result = await changeAdminRole(db, { email: actor.email, reason: '추가 전용 확인', role: 'ADMIN' });
    const before = await db.auditLog.findMany({ orderBy: { id: 'asc' } });
    await expect(
      db.auditLog.update({ where: { id: BigInt(result.auditId) }, data: { reason: '변경 시도' } }),
    ).rejects.toThrow();
    await expect(db.auditLog.delete({ where: { id: BigInt(result.auditId) } })).rejects.toThrow();
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE "AuditLog"')).rejects.toThrow();
    expect(await db.auditLog.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
});
