import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { T210User, T210World } from './t210-fixture';

// 실제 CLI가 표준 입력을 받아 역할과 감사 행을 확정한다. 시험용 관리자 API는 없다.
export async function adminRole(world: T210World, user: T210User, command: 'grant' | 'revoke') {
  const db = world.hold.db;
  await db.user.update({ where: { id: user.userId }, data: { emailVerifiedAt: new Date() } });
  const { email } = await db.user.findUniqueOrThrow({ where: { id: user.userId }, select: { email: true } });
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../tools/admin-role.ts', import.meta.url)), command],
    {
      env: { ...process.env, DATABASE_URL: world.stack.databaseUrl },
      windowsHide: true,
      timeout: 10_000,
      killSignal: 'SIGTERM',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '',
    failure: unknown;
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.resume();
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      if (failure || code !== 0) reject(new Error('자기 시험 DB의 관리자 CLI가 실패했습니다.'));
      else resolve();
    });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ email, reason: '관리자 조회 화면의 권한 검사' }));
  await closed;
  assert.equal(JSON.parse(output).role, command === 'grant' ? 'ADMIN' : 'USER');
  assert.equal((await db.auditLog.count({ where: { targetId: user.userId, action: 'admin.' + command } })) > 0, true);
}
