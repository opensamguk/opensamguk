import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const script = fileURLToPath(new URL('../deploy/entrypoint.sh', import.meta.url));
const marker = 'unexpected-child-start';

for (const name of ['DATABASE_URL', 'MAIL_API_KEY', 'RESEND_API_KEY'])
  for (const value of ['', 'private-counterexample-value'])
    it(`T2-15 AC-M2-08 원문 환경 ${name} 값 유무와 관계없이 실행을 거부한다 (${value ? '값' : '빈 값'})`, async () => {
      const env = { ...process.env };
      delete env.DATABASE_URL;
      delete env.MAIL_API_KEY;
      delete env.RESEND_API_KEY;
      env[name] = value;
      const result = await run(bash, [script, process.execPath, '-e', `process.stdout.write('${marker}')`], {
        env,
        timeout: 5000,
      }).then(
        () => ({ code: 0, stdout: '', stderr: '' }),
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe('실행 비밀 파일과 명령을 확인하세요.');
      expect(result.stderr).not.toContain(marker);
      expect(result.stderr).not.toContain('private-counterexample-value');
    });

it('T2-15 AC-M2-08 다른 메일 키 경로는 파일을 읽거나 자식을 실행하기 전에 거부한다', async () => {
  const env = { ...process.env, MAIL_API_KEY_FILE: '/outside/private-key' };
  delete env.DATABASE_URL;
  delete env.MAIL_API_KEY;
  delete env.RESEND_API_KEY;
  const result = await run(bash, [script, process.execPath, '-e', `process.stdout.write('${marker}')`], { env }).then(
    () => ({ code: 0, stdout: '', stderr: '' }),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe('실행 비밀 파일과 명령을 확인하세요.');
});
