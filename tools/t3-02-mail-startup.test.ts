import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

async function run(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 5000) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '',
    timedOut = false,
    spawnError: unknown;
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      spawnError = error;
    });
    // close는 소유 프로세스 종료와 stdout/stderr 배출이 끝난 뒤 발생한다.
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  if (spawnError) throw new Error('시험 자식 프로세스를 실행하지 못했습니다.');
  return { ...result, output, timedOut };
}

it.each([undefined, 'capture', 'unsupported'])(
  '실제 운영 API 실행은 미확정 메일 전송(%s)을 거부한다',
  async (transport) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://game.example.test',
      DATABASE_URL: 'postgresql://unused@127.0.0.1:1/no_connection_expected_test',
    };
    if (transport === undefined) delete env.MAIL_TRANSPORT;
    else env.MAIL_TRANSPORT = transport;
    const result = await run(
      ['--import', 'tsx', fileURLToPath(new URL('../apps/server/src/index.ts', import.meta.url))],
      env,
    );
    expect({ code: result.code, signal: result.signal, timedOut: result.timedOut }).toEqual({
      code: 1,
      signal: null,
      timedOut: false,
    });
    expect(result.output.includes('메일 전송 설정을 확인하세요.')).toBe(true);
    expect(result.output.includes('Server listening')).toBe(false);
  },
  10_000,
);

it('시작 검사 timeout도 소유 자식을 종료하고 close를 기다린다', async () => {
  const result = await run(['-e', 'setInterval(() => {}, 1000)'], process.env, 100);
  expect(result.timedOut).toBe(true);
  expect(result.code !== null || result.signal !== null).toBe(true);
});
