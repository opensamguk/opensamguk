import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { changeAdminRole } from '../apps/server/src/admin/roleStore';
import { changeResourceEditorPermission } from '../apps/server/src/resourceAdmin/permission';
import { testDatabaseUrl } from './test-database';

if (!process.env.TEST_DATABASE_URL) throw new Error('전용 시험 DB가 필요합니다.');
const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('loopback 시험 DB가 필요합니다.');
const db = createDb(url.href),
  origin = 'http://127.0.0.1:5173',
  users: string[] = [];
let app: Awaited<ReturnType<typeof buildServer>>, base: string;

async function actor(role: 'USER' | 'ADMIN' = 'ADMIN', status: 'ACTIVE' | 'WITHDRAWN' | 'SANCTIONED' = 'ACTIVE') {
  const user = await db.user.create({
    data: { email: `${randomUUID()}@example.test`, passwordHash: 'not-a-login-hash', role, status },
  });
  users.push(user.id);
  const session = newSession(Date.now());
  await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
  return { ...user, cookie: `sid=${session.token}` };
}
async function access(cookie: string) {
  const response = await fetch(`${base}/trpc/admin.whoami?batch=1&input=${encodeURIComponent('{}')}`, {
    headers: { origin, cookie },
  });
  const body = (await response.json()) as Array<{
    result?: { data: { admin: boolean; resourceEditor: boolean } };
    error?: { data: { code: string } };
  }>;
  return { status: response.status, data: body[0]?.result?.data, code: body[0]?.error?.data.code };
}
async function snapshot() {
  return {
    grants: await db.resourceEditorGrant.findMany({ orderBy: { userId: 'asc' } }),
    audits: await db.auditLog.findMany({ orderBy: { id: 'asc' } }),
  };
}
async function cli(args: string[], body: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tools/resource-editor.ts', ...args], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, DATABASE_URL: url.href },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdin.on('error', () => {});
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  child.stdin.end(body);
  return done;
}

beforeAll(async () => {
  app = await buildServer({ db, publicOrigin: origin, logging: false });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  const results = await Promise.allSettled([app?.close(), db.user.deleteMany({ where: { id: { in: users } } })]);
  await db.$disconnect();
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      '권한 시험 정리 실패',
    );
});

it('AC-P2-27 기본 권한 없음·실제 CLI 부여·중복 부여·회수가 같은 세션 HTTP에 즉시 반영된다', async () => {
  const user = await actor();
  expect(await access(user.cookie)).toMatchObject({ status: 200, data: { admin: true, resourceEditor: false } });
  for (const [command, enabled, changed] of [
    ['grant', true, true],
    ['grant', true, false],
    ['revoke', false, true],
  ] as const) {
    const result = await cli(
      [command],
      JSON.stringify({ email: ` ${user.email.toUpperCase()} `, reason: '전용 권한 시험' }),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { auditId: string };
    expect(output).toEqual({
      userId: user.id,
      resourceEditor: enabled,
      changed,
      auditId: expect.stringMatching(/^\d+$/),
    });
    expect(result.stdout).not.toContain(user.email);
    expect(result.stdout).not.toContain(user.passwordHash);
    expect(await access(user.cookie)).toMatchObject({ status: 200, data: { resourceEditor: enabled } });
    expect(await db.auditLog.findUniqueOrThrow({ where: { id: BigInt(output.auditId) } })).toMatchObject({
      actorKind: 'CLI',
      actorUserId: null,
      action: `resource-editor.${command}`,
      targetType: 'User',
      targetId: user.id,
      reason: '전용 권한 시험',
      payload: { after: enabled, changed },
    });
  }
});

for (const [role, status] of [
  ['USER', 'ACTIVE'],
  ['ADMIN', 'WITHDRAWN'],
  ['ADMIN', 'SANCTIONED'],
] as const)
  it(`AC-P2-27 ${role}/${status}에는 편집 권한을 부여하지 않는다`, async () => {
    const user = await actor(role, status),
      before = await snapshot();
    await expect(
      changeResourceEditorPermission(db, { email: user.email, reason: '거부 시험', grant: true }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

it('AC-P2-27 활성 제재가 있는 관리자의 부여는 거부하고 기존 편집 권한은 회수할 수 있다', async () => {
  const user = await actor();
  await changeResourceEditorPermission(db, { email: user.email, reason: '사전 부여', grant: true });
  const sanction = await db.sanction.create({ data: { userId: user.id, reason: '전용 시험', createdBy: 'test-cli' } });
  try {
    const before = await snapshot();
    await expect(
      changeResourceEditorPermission(db, { email: user.email, reason: '거부 시험', grant: true }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect((await access(user.cookie)).code).toBe('UNAUTHORIZED');
    await changeResourceEditorPermission(db, { email: user.email, reason: '제재 후 회수', grant: false });
    expect(await db.resourceEditorGrant.findUnique({ where: { userId: user.id } })).toBeNull();
  } finally {
    await db.sanction.delete({ where: { id: sanction.id } });
  }
});

it('AC-P2-27 관리자 회수는 편집 권한도 감사와 함께 회수하며 재임명으로 복구되지 않는다', async () => {
  const user = await actor();
  await changeResourceEditorPermission(db, { email: user.email, reason: '사전 부여', grant: true });
  await changeAdminRole(db, { email: user.email, reason: '관리자 회수', role: 'USER' });
  expect((await access(user.cookie)).code).toBe('FORBIDDEN');
  expect(await db.resourceEditorGrant.findUnique({ where: { userId: user.id } })).toBeNull();
  expect(await db.auditLog.findFirst({ where: { targetId: user.id, action: 'resource-editor.revoke' } })).toMatchObject(
    {
      reason: '관리자 회수',
      payload: { before: true, after: false, changed: true },
    },
  );
  await changeAdminRole(db, { email: user.email, reason: '재임명 시험', role: 'ADMIN' });
  expect(await access(user.cookie)).toMatchObject({ status: 200, data: { resourceEditor: false } });
});

it('AC-P2-27 동시 부여는 한 번만 권한을 바꾸고 관리자 회수와 경합해도 남는 권한이 없다', async () => {
  const user = await actor();
  const input = { email: user.email, reason: '동시 요청', grant: true };
  const granted = await Promise.all([
    changeResourceEditorPermission(db, input),
    changeResourceEditorPermission(db, input),
  ]);
  expect(granted.map((result) => result.changed).sort()).toEqual([false, true]);
  const raced = await Promise.allSettled([
    changeResourceEditorPermission(db, input),
    changeAdminRole(db, { email: user.email, reason: '동시 회수', role: 'USER' }),
  ]);
  expect(raced[1]!.status).toBe('fulfilled');
  expect(await db.resourceEditorGrant.findUnique({ where: { userId: user.id } })).toBeNull();
});

it('AC-P2-27 감사 삽입이 실패하면 부여·회수와 관리자 회수가 모두 되돌아간다', async () => {
  const user = await actor();
  await db.$executeRawUnsafe(`CREATE FUNCTION resource_editor_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."targetId"='${user.id}' THEN RAISE EXCEPTION 'test_audit_failure'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe(
    'CREATE TRIGGER resource_editor_audit_failure BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION resource_editor_audit_failure()',
  );
  try {
    const before = await snapshot();
    await expect(
      changeResourceEditorPermission(db, { email: user.email, reason: '감사 실패', grant: true }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await db.resourceEditorGrant.create({ data: { userId: user.id } });
    const granted = await snapshot();
    await expect(
      changeResourceEditorPermission(db, { email: user.email, reason: '감사 실패', grant: false }),
    ).rejects.toThrow();
    await expect(changeAdminRole(db, { email: user.email, reason: '감사 실패', role: 'USER' })).rejects.toThrow();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('ADMIN');
    expect(await snapshot()).toEqual(granted);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER resource_editor_audit_failure ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION resource_editor_audit_failure()');
  }
});

for (const body of [
  'invalid-json',
  'x'.repeat(4097),
  JSON.stringify({ email: 'absent@example.test', reason: '' }),
  JSON.stringify({ email: 'absent@example.test', reason: '시험', actorUserId: randomUUID() }),
])
  it(`AC-P2-27 CLI 잘못된 입력 ${body.length}바이트는 DB와 감사를 바꾸지 않는다`, async () => {
    const before = await snapshot(),
      result = await cli(['grant'], body);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      '자원 편집 권한을 변경하지 못했습니다. 명령·표준 입력·대상 계정·DB 설정을 확인하세요.\n',
    );
    expect(await snapshot()).toEqual(before);
  });
