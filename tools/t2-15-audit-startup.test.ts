import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('T2-15 AC-M2-08 audit 파일 오류는 API·Prisma 적재 전에 고정 문구로 거부한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensamguk-audit-startup-'));
  const mail = join(directory, 'mail');
  try {
    await writeFile(mail, 're_' + randomBytes(16).toString('hex'), { mode: 0o600 });
    for (const supplied of [false, true]) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://unused@127.0.0.1:1/no_connection_expected_test',
        MAIL_TRANSPORT: 'resend',
        MAIL_FROM: 'ops@example.invalid',
        MAIL_API_KEY_FILE: mail,
        OPENSAMGUK_RESOURCES_ROOT: fileURLToPath(new URL('../resources/', import.meta.url)),
        AUDIT_HASH_CONFIG_FILE: join(directory, 'private-path-canary'),
      };
      delete env.AUDIT_HASH_KEY;
      delete env.AUDIT_HASH_KEY_VERSION;
      if (supplied) {
        env.AUDIT_HASH_KEY = randomBytes(32).toString('hex');
        env.AUDIT_HASH_KEY_VERSION = '7';
      }
      const child = spawn(
        process.execPath,
        [
          '--import',
          new URL('./test-support/mail-startup-dependency-guard.mjs', import.meta.url).href,
          '--import',
          'tsx',
          fileURLToPath(new URL('../apps/server/src/index.ts', import.meta.url)),
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      let output = '',
        timedOut = false,
        spawnError = false;
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, 5000);
        child.once('error', () => {
          spawnError = true;
        });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });
      expect(spawnError).toBe(false);
      expect({ ...result, timedOut }).toEqual({ code: 1, signal: null, timedOut: false });
      if (supplied) {
        expect(output.includes('MAIL_STARTUP_DEPENDENCY_LOADED')).toBe(true);
      } else {
        expect(output.trim()).toBe('로그인 조사 키 설정을 확인하세요.');
      }
      expect(output.includes('private-path-canary')).toBe(false);
      expect(output.includes('Server listening')).toBe(false);
    }
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(basename(directory).startsWith('opensamguk-audit-startup-')).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
