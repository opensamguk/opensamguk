import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, expect, it as registered } from 'vitest';
import { nodeCli } from '../node-cli';
import { UPTIME_REF, updateUptimeGit } from './uptimeGit';
import { gitProcess, UptimeGitError } from './uptimeGitProcess';
import { runUptimeDrill, readUptimeDrillConfig, type UptimeDrillConfig } from './uptimeDrillRun';

const exec = promisify(execFile),
  directories: string[] = [],
  preserved = new Set<string>(),
  pending = new Set<Promise<void>>();
const root = fileURLToPath(new URL('../../', import.meta.url)),
  cli = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/uptime-drill-child.ts', import.meta.url));
const NOW = Date.UTC(2026, 9, 29);
function it(name: string, body: () => Promise<void>, timeout = 60_000) {
  registered(
    name,
    () => {
      const work = body();
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
async function git(args: string[]) {
  return (
    await exec('git', args, { windowsHide: true, timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  ).stdout.trimEnd();
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'opensamguk-drill-test-'));
  directories.push(directory);
  const bare = join(directory, 'remote.git');
  await git(['init', '--bare', '--quiet', bare]);
  return { directory, bare };
}
const config = (runId = '100', status = '500'): UptimeDrillConfig => ({
  key: 'owned-A_01',
  status,
  stateRef: UPTIME_REF,
  remote: 'https://example.invalid/repository.git',
  runId,
  runAttempt: '1',
});
type Receipt = {
  ok: boolean;
  key?: string;
  runId?: string;
  lastRunId?: string;
  head?: string;
  decision?: string | null;
  alerting?: boolean;
  committed?: boolean;
  observation?: string;
  consecutiveFailures?: number;
  targets?: Array<{ path: string; status: number; outcome: string }>;
  kinds?: string[];
  commands: string[];
  directories: string[];
  ports: number[];
  pids: number[];
  closed: boolean;
};
async function child(directory: string, bare: string, input: UptimeDrillConfig, options: Record<string, unknown> = {}) {
  const file = join(directory, crypto.randomUUID() + '.json');
  await writeFile(
    file,
    JSON.stringify({ config: input, localRemote: bare, now: NOW + Number(input.runId), ...options }),
    { flag: 'wx' },
  );
  const [binary, args] = nodeCli(cli, [fixture, file]);
  let result: Awaited<ReturnType<typeof gitProcess>>;
  try {
    result = await gitProcess(args, {
      cwd: root,
      env: process.env,
      command: { file: binary, prefix: [] },
      timeoutMs: 30_000,
      graceMs: 1000,
    });
  } catch (error) {
    // 자식이 영수증을 남기지 못하면 이 시험의 원격 폴더도 보존한다.
    preserved.add(directory);
    throw error;
  }
  expect(result.stdout).not.toMatch(/private-(?:url|webhook|error|cleanup)-canary/);
  const receipt = JSON.parse(result.stdout) as Receipt;
  expect(result.code).toBe(receipt.ok ? 0 : 1);
  try {
    await processesClosed(receipt);
  } catch (error) {
    preserved.add(directory);
    throw error;
  }
  return receipt;
}
function pidAbsent(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
    return;
  }
  throw new Error('자기 자식 PID가 아직 실행 중입니다: ' + pid);
}
async function processesClosed(receipt: Pick<Receipt, 'ports' | 'pids'>) {
  for (const port of receipt.ports) {
    const result = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error('자기 listener 종료 관측 기한 초과'));
      });
      socket.once('error', (error) => {
        socket.destroy();
        resolve((error as NodeJS.ErrnoException).code ?? 'unknown');
      });
      socket.once('connect', () => {
        socket.destroy();
        resolve('open');
      });
    });
    expect(result).toBe('ECONNREFUSED');
  }
  for (const pid of receipt.pids) pidAbsent(pid);
}
async function cleaned(receipt: Receipt) {
  await processesClosed(receipt);
  for (const directory of receipt.directories) await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
}
afterAll(async () => {
  const work = await Promise.allSettled([...pending]);
  const cleanup = await Promise.allSettled(
    directories.map(async (directory) => {
      if (preserved.has(directory)) throw new Error('자식 종료를 확인하지 못해 시험 폴더를 보존했습니다: ' + directory);
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(basename(directory).startsWith('opensamguk-drill-test-')).toBe(true);
      await rm(directory, { recursive: true, maxRetries: process.platform === 'win32' ? 10 : 0, retryDelay: 50 });
    }),
  );
  const failures = [...work, ...cleanup].flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, '자기 연습 시험 정착·정리 실패');
}, 120_000);

it('T3-11 AC-M3-09 잘못된 연습 입력·ref·원격·run·토큰은 listener/HTTP/Git 전에 거부한다', async () => {
  const { bare } = await setup();
  let listened = 0,
    commands = 0;
  const invalid = [
    ...['', '../prod', 'a/b', 'prod\n', '가', 'a'.repeat(65), 'x;run'].map((key) => ({ ...config(), key })),
    ...['', '201', '0500', '500\n'].map((status) => ({ ...config(), status })),
    { ...config(), stateRef: 'refs/heads/main' },
    ...[
      'http://example.invalid/a',
      'https://u:p@example.invalid/a',
      'https://example.invalid/a?',
      'https://example.invalid/a#',
      'https://example.invalid/a\\b',
      'https://example.invalid/',
    ].map((remote) => ({ ...config(), remote })),
    { ...config(), runId: '0' },
    { ...config(), runAttempt: '1\n' },
  ];
  for (const input of invalid)
    await expect(
      runUptimeDrill(input, { git: { localRemote: bare, onCommand: () => commands++ }, onListen: () => listened++ }),
    ).rejects.toMatchObject({ kind: 'configuration' });
  for (const git of [
    { localRemote: 'relative-path' },
    { localRemote: bare, httpsToken: 'invalid token' },
    { httpsToken: '' },
  ])
    await expect(runUptimeDrill(config(), { git, onListen: () => listened++ })).rejects.toMatchObject({
      kind: 'configuration',
    });
  expect(listened).toBe(0);
  expect(commands).toBe(0);
  expect(() => readUptimeDrillConfig({ DRILL_KEY: 'safe', DRILL_STATUS: '500', UPTIME_GIT_TOKEN: '' })).toThrow();
});

it('T3-11 AC-M3-09 실제 HTTP·분리 자식·bare Git의500/500/500/200과 중복 실행은 prod/타키를 보존한다', async () => {
  const { directory, bare } = await setup();
  for (const key of ['prod', 'drill-other'])
    await updateUptimeGit(
      {
        remote: config().remote,
        stateRef: UPTIME_REF,
        key,
        operation: {
          kind: 'observe',
          observation: { key, runId: '1', runAttempt: '1', now: NOW, ok: true, webhookConfigured: false },
        },
      },
      { localRemote: bare },
    );
  const preserved = await Promise.all(
    ['prod', 'drill-other'].map((key) =>
      git(['--git-dir', bare, 'rev-parse', UPTIME_REF + ':uptime/' + key + '.json']),
    ),
  );
  const receipts: Receipt[] = [];
  for (const [index, status] of ['500', '500', '500', '200'].entries()) {
    const runId = String(100 + index),
      receipt = await child(directory, bare, config(runId, status));
    receipts.push(receipt);
    expect(receipt).toMatchObject({
      ok: true,
      key: 'drill-owned-A_01',
      runId,
      lastRunId: runId,
      committed: true,
      observation: 'applied',
      closed: true,
    });
    expect(receipt.head).toMatch(/^[a-f0-9]{40}$/);
    expect(receipt.targets).toEqual([
      { path: '/healthz', outcome: status === '200' ? 'ok' : 'status', status: Number(status) },
      { path: '/healthz/engine', outcome: status === '200' ? 'ok' : 'status', status: Number(status) },
    ]);
    await cleaned(receipt);
    expect(
      await Promise.all(
        ['prod', 'drill-other'].map((key) =>
          git(['--git-dir', bare, 'rev-parse', UPTIME_REF + ':uptime/' + key + '.json']),
        ),
      ),
    ).toEqual(preserved);
    const saved = JSON.parse(await git(['--git-dir', bare, 'show', UPTIME_REF + ':uptime/drill-owned-A_01.json']));
    expect(saved.lastRunId).toBe(runId);
    expect(saved.pending).toEqual([]);
  }
  expect(receipts.map((v) => v.decision)).toEqual([null, 'down', null, 'recovery']);
  expect(receipts.map((v) => v.alerting)).toEqual([false, true, true, false]);
  expect(receipts.map((v) => v.consecutiveFailures)).toEqual([1, 2, 2, 0]);
  const duplicate = await child(directory, bare, config('103', '200'));
  expect(duplicate).toMatchObject({
    ok: true,
    decision: null,
    observation: 'skipped',
    committed: false,
    head: receipts[3]!.head,
  });
  await cleaned(duplicate);
});

it('T3-11 AC-M3-09 실제 Git 읽기·쓰기 실패와 정리 오류는 성공으로 숨기지 않고 자기 listener를 닫는다', async () => {
  const { directory, bare } = await setup();
  const missing = await child(directory, join(directory, 'absent.git'), config());
  expect(missing).toMatchObject({ ok: false, kinds: ['git'], closed: true });
  expect(missing.commands).toContain('ls-remote');
  expect(missing.commands).not.toContain('push');
  await cleaned(missing);
  const rejected = join(directory, 'rejected');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const hook = join(bare, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nprintf reject\\n >> ' + quote(rejected.replaceAll('\\', '/')) + '\nexit 1\n');
  await chmod(hook, 0o700);
  const denied = await child(directory, bare, config());
  expect(denied).toMatchObject({ ok: false, kinds: ['git'], closed: true });
  expect(denied.commands.filter((name) => name === 'push')).toHaveLength(3);
  expect((await readFile(rejected, 'utf8')).match(/reject/g)).toHaveLength(3);
  await cleaned(denied);
  expect(await git(['--git-dir', bare, 'for-each-ref', '--format=%(refname)'])).toBe('');
  await rm(hook);
  const cleanup = await child(directory, bare, config(), { failCleanup: true });
  expect(cleanup).toMatchObject({ ok: false, kinds: ['cleanup'], closed: true });
  await cleaned(cleanup);
  const saved = JSON.parse(await git(['--git-dir', bare, 'show', UPTIME_REF + ':uptime/drill-owned-A_01.json']));
  expect(saved.lastRunId).toBe('100');
});

it('T3-11 AC-M3-09 공개 CLI의 인자·불완전 입력 오류는 비밀·원격 원문을 출력하지 않는다', async () => {
  const entry = fileURLToPath(new URL('./uptimeDrill.ts', import.meta.url));
  for (const [args, key, status] of [
    [['unexpected-private-argument'], 'safe', '500'],
    [[], '', '500'],
    [[], 'safe', '201'],
  ] as const) {
    const [binary, argv] = nodeCli(cli, [entry, ...args]);
    const result = await gitProcess(argv, {
      cwd: root,
      command: { file: binary, prefix: [] },
      timeoutMs: 10_000,
      graceMs: 1000,
      env: {
        ...process.env,
        DRILL_KEY: key,
        DRILL_STATUS: status,
        UPTIME_STATE_REF: UPTIME_REF,
        UPTIME_GIT_REMOTE: 'https://private-remote-canary.invalid/repo.git',
        UPTIME_GIT_TOKEN: 'private-token-canary',
        PUBLIC_URL: 'private-url-canary',
        OPS_DISCORD_WEBHOOK: 'private-webhook-canary',
      },
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, kinds: ['configuration'] });
    expect(result.stdout).not.toMatch(/private-(?:argument|remote|token|url|webhook)/);
  }
});

it('T3-11 AC-M3-09 실제 연습 자식 강제 종료 뒤 자기 listener와 Git 자식이 남지 않는다', async () => {
  const { directory, bare } = await setup(),
    record = join(directory, 'hang.json'),
    input = join(directory, 'hang-input.json');
  await writeFile(
    input,
    JSON.stringify({ config: config(), localRemote: bare, now: NOW + 100, hangBeforeRead: record }),
    { flag: 'wx' },
  );
  const [binary, argv] = nodeCli(cli, [fixture, input]);
  let childPid: number | undefined, termination: unknown;
  try {
    try {
      await gitProcess(argv, {
        cwd: root,
        env: process.env,
        command: { file: binary, prefix: [] },
        timeoutMs: 5000,
        graceMs: 1000,
        onSpawn: (pid) => {
          childPid = pid;
        },
      });
    } catch (error) {
      termination = error;
    }
    expect(termination).toBeInstanceOf(UptimeGitError);
    expect(termination).toMatchObject({ kind: 'timeout', cleanupSafe: true });
    expect(childPid).toBeTypeOf('number');
    pidAbsent(childPid!);
    const metadata = JSON.parse(await readFile(record, 'utf8')) as Pick<Receipt, 'ports' | 'directories' | 'pids'>;
    expect(metadata.ports).toHaveLength(1);
    expect(metadata.directories).toHaveLength(1);
    await processesClosed(metadata);
    for (const owned of metadata.directories) {
      expect(dirname(resolve(owned))).toBe(resolve(tmpdir()));
      expect(basename(owned).startsWith('opensamguk-uptime-git-')).toBe(true);
      await rm(owned, { recursive: true });
    }
    await cleaned({ ok: false, commands: [], closed: true, ...metadata });
    expect(await git(['--git-dir', bare, 'for-each-ref', '--format=%(refname)', UPTIME_REF])).toBe('');
  } catch (error) {
    preserved.add(directory);
    throw error;
  }
}, 15_000);
