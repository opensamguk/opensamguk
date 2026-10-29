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

it.each([undefined, 'capture', 'unsupported', 'resend'])(
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
    delete env.MAIL_FROM;
    delete env.MAIL_API_KEY_FILE;
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

const guardedEntry = [
  '--import',
  new URL('./test-support/mail-startup-dependency-guard.mjs', import.meta.url).href,
  '--import',
  'tsx',
  fileURLToPath(new URL('../apps/server/src/index.ts', import.meta.url)),
];

function guardedEnvironment(transport: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://game.example.test',
    DATABASE_URL: 'postgresql://unused@127.0.0.1:1/no_connection_expected_test',
  };
  if (transport === undefined) delete env.MAIL_TRANSPORT;
  else env.MAIL_TRANSPORT = transport;
  delete env.MAIL_FROM;
  delete env.MAIL_API_KEY_FILE;
  return env;
}

it.each([undefined, 'capture', 'unsupported', 'resend'])(
  '메일 설정(%s)은 API·Prisma 모듈을 적재하기 전에 거부한다',
  async (transport) => {
    const result = await run(guardedEntry, guardedEnvironment(transport));
    expect({ code: result.code, signal: result.signal, timedOut: result.timedOut }).toEqual({
      code: 1,
      signal: null,
      timedOut: false,
    });
    expect(result.output.includes('메일 전송 설정을 확인하세요.')).toBe(true);
    expect(result.output.includes('MAIL_STARTUP_DEPENDENCY_LOADED')).toBe(false);
    expect(result.output.includes('Server listening')).toBe(false);
  },
  10_000,
);

it('정상 개발 메일 설정은 의존성 적재 차단기에 도달한다', async () => {
  const env = guardedEnvironment('capture');
  env.NODE_ENV = 'development';
  const result = await run(guardedEntry, env);
  expect({ code: result.code, signal: result.signal, timedOut: result.timedOut }).toEqual({
    code: 1,
    signal: null,
    timedOut: false,
  });
  expect(result.output.includes('MAIL_STARTUP_DEPENDENCY_LOADED')).toBe(true);
  expect(result.output.includes('메일 전송 설정을 확인하세요.')).toBe(false);
  expect(result.output.includes('Server listening')).toBe(false);
}, 10_000);

it('DB 주소가 없으면 메일 검사와 의존성 적재 전에 기존 오류로 거부한다', async () => {
  const env = guardedEnvironment(undefined);
  delete env.DATABASE_URL;
  const result = await run(guardedEntry, env);
  expect({ code: result.code, signal: result.signal, timedOut: result.timedOut }).toEqual({
    code: 1,
    signal: null,
    timedOut: false,
  });
  expect(result.output.includes('DATABASE_URL이 없습니다.')).toBe(true);
  expect(result.output.includes('메일 전송 설정을 확인하세요.')).toBe(false);
  expect(result.output.includes('MAIL_STARTUP_DEPENDENCY_LOADED')).toBe(false);
  expect(result.output.includes('Server listening')).toBe(false);
}, 10_000);
