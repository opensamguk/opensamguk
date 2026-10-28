import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeEach, expect, it as registeredTest } from 'vitest';
import { readUptimeConfig } from './uptimeConfig';
import { UPTIME_REF, updateUptimeGit, type UptimeGitInput } from './uptimeGit';
import { validateUptimeToken, writeUptimeAuthConfig } from './uptimeGitAuth';
import { gitProcess } from './uptimeGitProcess';
import { runUptime } from './uptimeRun';

const exec = promisify(execFile),
  root = fileURLToPath(new URL('../../', import.meta.url)),
  loader = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href,
  entry = fileURLToPath(new URL('./uptime.ts', import.meta.url)),
  child = fileURLToPath(new URL('../fixtures/uptime-auth-child.ts', import.meta.url));
const pending = new Set<Promise<void>>();
function it(name: string, body: () => void | Promise<void>, timeout = 15000) {
  registeredTest(
    name,
    () => {
      const work = Promise.resolve().then(body);
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    },
    timeout,
  );
}
async function settle() {
  const results = await Promise.allSettled([...pending]);
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, '인증 시험 본문 정착 실패.');
}
beforeEach(settle, 30000);
afterAll(settle, 30000);
async function withCleanup(body: () => Promise<void>, cleanups: (() => Promise<void>)[]) {
  const errors: unknown[] = [];
  try {
    await body();
  } catch (error) {
    errors.push(error);
  }
  const results = await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve().then(cleanup)));
  for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, '인증 시험 본문·정리 실패.');
}
const canary = 'fixture-uptime-private-canary';
const env = {
  UPTIME_STATE_REF: UPTIME_REF,
  PUBLIC_URL: 'https://example.invalid',
  UPTIME_GIT_REMOTE: 'https://example.invalid/repository.git',
  GITHUB_RUN_ID: '1',
  GITHUB_RUN_ATTEMPT: '1',
  UPTIME_GIT_TOKEN: canary,
};
const input: UptimeGitInput = {
  remote: env.UPTIME_GIT_REMOTE,
  stateRef: UPTIME_REF,
  key: 'prod',
  operation: {
    kind: 'observe',
    observation: { key: 'prod', runId: '1', runAttempt: '1', now: Date.now(), ok: true, webhookConfigured: false },
  },
};
async function temporary(body: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'opensamguk-uptime-auth-test-'));
  await withCleanup(() => body(directory), [() => rm(directory, { recursive: true })]);
}
it('본문·독립 정리 오류를 모두 보존한다', async () => {
  const body = new Error('body'),
    first = new Error('first'),
    second = new Error('second');
  let cleanups = 0;
  await expect(
    withCleanup(async () => {
      throw body;
    }, [
      async () => {
        cleanups++;
        throw first;
      },
      async () => {
        cleanups++;
        throw second;
      },
    ]),
  ).rejects.toMatchObject({ errors: [body, first, second] });
  expect(cleanups).toBe(2);
});
it('설정은 ref 우선·꺼짐과 prod 기본을 유지하고 활성 인증을 사전 검사한다', () => {
  expect(() => readUptimeConfig({ ...env, UPTIME_STATE_REF: 'wrong', PUBLIC_URL: '' })).toThrow();
  expect(
    readUptimeConfig({
      UPTIME_STATE_REF: UPTIME_REF,
      PUBLIC_URL: '',
      UPTIME_GIT_TOKEN: '\n',
      UPTIME_GIT_REMOTE: 'invalid',
    }).token,
  ).toBeUndefined();
  for (const token of [undefined, '', ' ', 'a\nb', 'a\tb', 'a\u007fb', '한글', 'x'.repeat(4097)])
    expect(() => validateUptimeToken(token)).toThrow();
  if (process.platform === 'win32') expect(() => readUptimeConfig(env)).toThrow();
  else expect(readUptimeConfig(env).config.key).toBe('prod');
});
it('실제 Node CLI는 꺼짐·잘못된 설정에서 HTTP·Git 폴더 없이 안전한 JSON만 출력한다', async () => {
  await temporary(async (directory) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end();
    });
    await withCleanup(async () => {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error();
      const local = `https://127.0.0.1:${address.port}`;
      const cases: { values: NodeJS.ProcessEnv; code: number; args?: string[] }[] = [
        { values: { ...env, PUBLIC_URL: '', UPTIME_GIT_REMOTE: 'bad', UPTIME_GIT_TOKEN: '\n' }, code: 0 },
        { values: { ...env, PUBLIC_URL: '', UPTIME_STATE_REF: 'wrong' }, code: 1 },
        { values: { ...env, PUBLIC_URL: '' }, code: 1, args: ['unexpected'] },
        { values: { ...env, PUBLIC_URL: local, UPTIME_GIT_TOKEN: '' }, code: 1 },
        { values: { ...env, PUBLIC_URL: local, UPTIME_GIT_REMOTE: 'file:///private-canary' }, code: 1 },
        {
          values: { ...env, PUBLIC_URL: local, OPS_DISCORD_WEBHOOK: 'https://invalid.example/private-canary' },
          code: 1,
        },
        ...(process.platform === 'win32' ? [{ values: { ...env, PUBLIC_URL: local }, code: 1 }] : []),
      ];
      for (const test of cases) {
        const result = await exec(process.execPath, ['--import', loader, entry, ...(test.args ?? [])], {
          cwd: root,
          timeout: 10000,
          windowsHide: true,
          env: {
            ...process.env,
            ...test.values,
            TMP: directory,
            TEMP: directory,
            TMPDIR: directory,
            TSX_DISABLE_CACHE: '1',
          },
        }).then(
          (value) => ({ ...value, code: 0 }),
          (error) => ({ stdout: String(error.stdout), stderr: String(error.stderr), code: Number(error.code) }),
        );
        expect(result.code).toBe(test.code);
        expect(result.stderr).toBe('');
        const output = JSON.parse(result.stdout);
        expect(output).toEqual(
          test.code === 0 ? { ok: true, mode: 'disabled' } : { ok: false, kind: 'configuration', warnings: [] },
        );
        expect(result.stdout.includes(canary) || result.stdout.includes('https:')).toBe(false);
        expect(await readdir(directory)).toEqual([]);
      }
      expect(requests).toBe(0);
    }, [
      async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      },
    ]);
  });
}, 30000);
it('활성 인증 오류는 확인 요청과 Git 임시 폴더 생성 전에 거부한다', async () => {
  let probes = 0,
    directories = 0;
  const config = {
    stateRef: UPTIME_REF,
    publicUrl: env.PUBLIC_URL,
    remote: env.UPTIME_GIT_REMOTE,
    key: 'prod',
    runId: '1',
    runAttempt: '1',
    webhook: '',
  };
  await expect(
    runUptime(config, {
      git: { httpsToken: '\n', onDirectory: () => directories++ },
      probe: async () => {
        probes++;
        throw new Error();
      },
    }),
  ).rejects.toMatchObject({ kind: 'configuration' });
  await expect(
    updateUptimeGit(input, { httpsToken: canary, localRemote: root, onDirectory: () => directories++ }),
  ).rejects.toMatchObject({ kind: 'configuration' });
  expect({ probes, directories }).toEqual({ probes: 0, directories: 0 });
});
it('실제 플랫폼의 인증 파일 권한을 확인하고 기록 실패를 닫는다', async () => {
  await temporary(async (directory) => {
    if (process.platform === 'win32') {
      await expect(writeUptimeAuthConfig(directory, env.UPTIME_GIT_REMOTE, canary)).rejects.toMatchObject({
        kind: 'configuration',
      });
      expect(await readdir(directory)).toEqual([]);
      return;
    }
    await chmod(directory, 0o700);
    await writeUptimeAuthConfig(directory, env.UPTIME_GIT_REMOTE, canary);
    const folder = await stat(directory),
      file = await stat(join(directory, 'gitconfig'));
    expect([folder.mode & 0o777, file.mode & 0o777, folder.uid, file.uid]).toEqual([
      0o700,
      0o600,
      process.getuid!(),
      process.getuid!(),
    ]);
    const expected = 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + canary).toString('base64');
    const result = await gitProcess(
      ['config', '--file', join(directory, 'gitconfig'), '--get-urlmatch', 'http.extraHeader', env.UPTIME_GIT_REMOTE],
      { cwd: directory, env: process.env, timeoutMs: 5000, graceMs: 1000 },
    );
    expect(result.code === 0 && result.stdout.trim() === expected).toBe(true);
    const raw = await readFile(join(directory, 'gitconfig'), 'utf8');
    expect(raw.includes(canary)).toBe(false);
    await expect(writeUptimeAuthConfig(directory, env.UPTIME_GIT_REMOTE, canary)).rejects.toMatchObject({
      kind: 'configuration',
    });
    expect((await readFile(join(directory, 'gitconfig'), 'utf8')) === raw).toBe(true);
  });
});
it('보호 실패와 기존 파일·링크에는 토큰을 쓰지 않는다', async () => {
  await temporary(async (directory) => {
    const file = join(directory, 'gitconfig');
    await writeFile(file, 'unchanged');
    if (process.platform !== 'win32') await chmod(directory, 0o755);
    await expect(writeUptimeAuthConfig(directory, env.UPTIME_GIT_REMOTE, canary)).rejects.toMatchObject({
      kind: 'configuration',
    });
    expect(await readFile(file, 'utf8')).toBe('unchanged');
    if (process.platform === 'win32') return;
    await rm(file);
    await chmod(directory, 0o700);
    const target = join(directory, 'unrelated');
    await writeFile(target, 'unchanged');
    await symlink(target, file);
    await expect(writeUptimeAuthConfig(directory, env.UPTIME_GIT_REMOTE, canary)).rejects.toMatchObject({
      kind: 'configuration',
    });
    expect(await readFile(target, 'utf8')).toBe('unchanged');
    await rm(file);
    await chmod(directory, 0o755);
    await expect(writeUptimeAuthConfig(directory, env.UPTIME_GIT_REMOTE, canary)).rejects.toMatchObject({
      kind: 'configuration',
    });
    expect(await readdir(directory)).toEqual(['unrelated']);
  });
});
it('실제 자식·Git은 URL 범위·TLS·비상속을 확인하고 인증 작업 폴더를 정리한다', async () => {
  await temporary(async (directory) => {
    const directories: string[] = [],
      receipt = join(directory, 'receipt.json');
    const original = { ...process.env };
    try {
      process.env.UPTIME_GIT_TOKEN = canary;
      process.env.GITHUB_TOKEN = canary;
      process.env.GH_TOKEN = canary;
      process.env.GIT_TRACE = '1';
      process.env.GIT_SSL_NO_VERIFY = '1';
      process.env.GIT_CONFIG_COUNT = '0';
      const result = updateUptimeGit(input, {
        httpsToken: canary,
        onDirectory: (path) => directories.push(path),
        process: {
          timeoutMs: 10000,
          graceMs: 1000,
          command: { file: process.execPath, prefix: ['--import', loader, child, receipt] },
        },
      });
      await expect(result).rejects.toMatchObject({ kind: process.platform === 'win32' ? 'configuration' : 'read' });
      if (process.platform === 'win32') {
        expect(directories).toEqual([]);
        expect(await readdir(directory)).toEqual([]);
      } else {
        expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({
          header: true,
          scoped: true,
          noPlaintext: true,
          isolated: true,
          tls: true,
          redirect: true,
          noSecretArgs: true,
          interactive: true,
          privateConfig: true,
        });
        expect(directories.length).toBe(1);
        for (const path of directories) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
      Object.assign(process.env, original);
    }
  });
}, 15000);
