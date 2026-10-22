// 루트 playwright.config.ts가 CI에서는 test.only와 기존 서버 재사용을 막고 로컬에서는 예전처럼 동작하는지
// 실제 Playwright CLI로 확인한다 (GitHub #26, #27). 서버는 이 시험이 직접 띄운 127.0.0.1 임의 포트만 쓴다.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureConfig = fileURLToPath(new URL('playwright-ci/fixture.config.ts', import.meta.url));
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 이 시험이 소유한 리스너. 받은 경로를 기록하고 표식을 돌려준다. */
async function startOwnListener(token: string) {
  const paths: string[] = [];
  const server: Server = createServer((request, response) => {
    paths.push(request.url ?? '');
    response.end(token);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, paths };
}

function portAcceptsConnections(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

interface RunOptions {
  ci: boolean;
  port: number;
  spec: 'only.spec' | 'normal.spec';
  serverToken?: string;
  expectToken?: string;
}

async function runPlaywright({ ci, port, spec, serverToken = '', expectToken = '' }: RunOptions) {
  const output = await mkdtemp(join(tmpdir(), 'opensamguk-playwright-ci-'));
  cleanups.push(() => rm(output, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FIXTURE_PORT: String(port),
    FIXTURE_SERVER_TOKEN: serverToken,
    FIXTURE_EXPECT_TOKEN: expectToken,
    FORCE_COLOR: '0',
  };
  delete env.CI;
  if (ci) env.CI = 'true';
  const child = spawn(
    process.execPath,
    [playwrightCli, 'test', '--config', fixtureConfig, '--output', output, '--reporter=line', spec],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let text = '';
  child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (text += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  return { code, text };
}

describe('GitHub #26 forbidOnly', { timeout: 90_000 }, () => {
  it('CI에서는 test.only가 있으면 실행을 거부한다', async () => {
    const result = await runPlaywright({ ci: true, port: await freePort(), spec: 'only.spec' });
    expect(result.code, result.text).not.toBe(0);
    expect(result.text).toContain("item focused with '.only' is not allowed");
    expect(result.text).not.toMatch(/\d+ passed/);
  });

  it('로컬에서는 예전처럼 test.only 하나만 실행한다', async () => {
    const result = await runPlaywright({ ci: false, port: await freePort(), spec: 'only.spec' });
    expect(result.code, result.text).toBe(0);
    expect(result.text).toContain('1 passed');
    expect(result.text).not.toContain('not allowed');
  });
});

describe('GitHub #27 reuseExistingServer', { timeout: 90_000 }, () => {
  it('CI에서 포트가 비어 있으면 자기 서버를 띄워 통과하고 끝나면 그 서버를 정리한다', async () => {
    const port = await freePort();
    const result = await runPlaywright({
      ci: true,
      port,
      spec: 'normal.spec',
      serverToken: 'fresh-server',
      expectToken: 'fresh-server',
    });
    expect(result.code, result.text).toBe(0);
    expect(result.text).toContain('1 passed');
    expect(await portAcceptsConnections(port)).toBe(false);
  });

  it('CI에서 이미 떠 있는 서버는 재사용하지 않고 실패한다', async () => {
    const existing = await startOwnListener('existing-server');
    const result = await runPlaywright({
      ci: true,
      port: existing.port,
      spec: 'normal.spec',
      serverToken: 'fresh-server',
      expectToken: 'existing-server',
    });
    expect(result.code, result.text).not.toBe(0);
    expect(result.text).toContain('is already used');
    expect(result.text).not.toMatch(/\d+ passed/);
    expect(existing.paths).not.toContain('/from-test');
  });

  it('로컬에서는 이미 떠 있는 서버를 그대로 쓴다', async () => {
    const existing = await startOwnListener('existing-server');
    const result = await runPlaywright({
      ci: false,
      port: existing.port,
      spec: 'normal.spec',
      serverToken: 'fresh-server',
      expectToken: 'existing-server',
    });
    expect(result.code, result.text).toBe(0);
    expect(result.text).toContain('1 passed');
    expect(existing.paths).toContain('/from-test');
  });
});
