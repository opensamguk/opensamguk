import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, expect, it as registeredTest } from 'vitest';
import { nodeCli } from '../node-cli';
import { UPTIME_REF, type UptimeGitInput } from './uptimeGit';
import { gitProcess, UptimeGitError } from './uptimeGitProcess';
import type { UptimeState } from './uptimeState';

const exec = promisify(execFile),
  directories: string[] = [];
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/uptime-git-child.ts', import.meta.url));
const hangFixture = fileURLToPath(new URL('../fixtures/uptime-git-hang.mjs', import.meta.url));
const NOW = Date.UTC(2026, 9, 29);
const pending = new Set<Promise<void>>();
function it(name: string, body: () => Promise<void>, timeout: number) {
  registeredTest(
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
type Receipt = {
  ok: boolean;
  result?: string;
  committed?: boolean;
  attempts?: number;
  head?: string;
  state?: UptimeState;
  kinds?: string[];
  commands: string[];
  directories: string[];
  pids: number[];
};
async function git(args: string[], cwd?: string) {
  return (
    await exec('git', args, {
      cwd,
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  ).stdout.trimEnd();
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'opensamguk-uptime-test-'));
  directories.push(directory);
  const bare = join(directory, 'remote.git');
  await git(['init', '--bare', '--quiet', bare]);
  return { directory, bare };
}
function observation(runId: string, key = 'prod', ok = false): UptimeGitInput {
  return {
    remote: 'https://example.invalid/repository.git',
    stateRef: UPTIME_REF,
    key,
    operation: {
      kind: 'observe',
      observation: { key, runId, runAttempt: '1', now: NOW + Number(runId), ok, webhookConfigured: true },
    },
  };
}
async function child(directory: string, bare: string, input: UptimeGitInput, options: Record<string, unknown> = {}) {
  const config = join(directory, 'input-' + crypto.randomUUID() + '.json');
  await writeFile(config, JSON.stringify({ input, localRemote: bare, ...options }), { flag: 'wx' });
  const [file, argv] = nodeCli(cli, [fixture, config]);
  const result = await gitProcess(argv, {
    cwd: root,
    env: process.env,
    command: { file, prefix: [] },
    timeoutMs: 30_000,
    graceMs: 1000,
  });
  const receipt = JSON.parse(result.stdout) as Receipt;
  expect(result.stdout).not.toContain('fixture-private-error-canary');
  expect(result.code).toBe(receipt.ok ? 0 : 1);
  return receipt;
}
async function count(bare: string) {
  const present = await git(['--git-dir', bare, 'for-each-ref', '--format=%(objectname)', UPTIME_REF]);
  return present ? Number(await git(['--git-dir', bare, 'rev-list', '--count', UPTIME_REF])) : 0;
}
async function state(bare: string, key = 'prod') {
  return JSON.parse(await git(['--git-dir', bare, 'show', `${UPTIME_REF}:uptime/${key}.json`])) as UptimeState;
}
async function closed(receipt: Receipt) {
  for (const directory of receipt.directories) await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(new Set(receipt.directories).size).toBe(receipt.directories.length);
}
async function removeOwned(directory: string, prefix: string) {
  expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
  expect(basename(directory).startsWith(prefix)).toBe(true);
  await rm(directory, { recursive: true, maxRetries: process.platform === 'win32' ? 10 : 0, retryDelay: 50 });
}
afterAll(async () => {
  // Vitest timeout도 본문 Promise를 취소하지 않으므로 실제 자식 작업의 정착을 먼저 기다린다.
  const settled = await Promise.allSettled([...pending]);
  const results = await Promise.allSettled(
    directories.map((directory) => removeOwned(directory, 'opensamguk-uptime-test-')),
  );
  const failures = [...settled, ...results].flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, 'Own test directory cleanup failed');
}, 120_000);

it('T3-11 AC-M3-09 잘못된 ref·키·원격은 Git 호출 전에 거부한다', async () => {
  const { directory, bare } = await setup();
  const numeric = observation('1');
  if (numeric.operation.kind === 'observe') numeric.operation.observation.runId = 1 as unknown as string;
  for (const input of [
    numeric,
    { ...observation('1'), stateRef: 'refs/heads/main' },
    { ...observation('1'), key: '../prod' },
    ...[
      'http://example.invalid/a',
      'ext::command',
      'https://user:secret@example.invalid/a',
      'https://example.invalid/a?',
      'https://example.invalid/a#',
    ].map((remote) => ({ ...observation('1'), remote })),
  ]) {
    const receipt = await child(directory, bare, input);
    expect(receipt.ok).toBe(false);
    expect(receipt.commands).toEqual([]);
    expect(receipt.directories).toEqual([]);
  }
  expect(await count(bare)).toBe(0);
}, 30_000);

it('T3-11 AC-M3-09 새 자식·새 저장소로 orphan부터 이어 쓰며 중복·옛 실행을 세지 않는다', async () => {
  const { directory, bare } = await setup();
  const first = await child(directory, bare, observation('1'));
  expect(first).toMatchObject({ ok: true, committed: true, result: 'applied' });
  await closed(first);
  expect(await git(['--git-dir', bare, 'rev-list', '--parents', UPTIME_REF])).toMatch(/^[a-f0-9]{40}$/);
  const second = await child(directory, bare, observation('2'));
  expect(second.state?.pending).toHaveLength(1);
  await closed(second);
  for (const run of ['2', '1']) {
    const input = observation(run, 'prod', true);
    if (input.operation.kind === 'observe') input.operation.observation.now = NOW + 3;
    const old = await child(directory, bare, input);
    expect(old).toMatchObject({ ok: true, committed: false, result: 'skipped', head: second.head });
    await closed(old);
  }
  const third = await child(directory, bare, observation('3'));
  expect(third.state?.pending).toHaveLength(1);
  await closed(third);
  expect(await count(bare)).toBe(3);
  expect(new Set([...first.directories, ...second.directories, ...third.directories]).size).toBe(3);
}, 30_000);

it('T3-11 AC-M3-09 prod와 drill의 실제 동시 push 경합에서 두 키와 부모를 보존한다', async () => {
  const { directory, bare } = await setup(),
    barrier = join(directory, 'barrier');
  await mkdir(barrier);
  const results = await Promise.allSettled([
    child(directory, bare, observation('10'), { barrier }),
    child(directory, bare, observation('11', 'drill-race'), { barrier }),
  ]);
  const failures = results.flatMap((value) => (value.status === 'rejected' ? [value.reason] : []));
  if (failures.length) throw new AggregateError(failures, 'Concurrent child execution failed');
  const receipts = results.map((value) => (value as PromiseFulfilledResult<Receipt>).value);
  expect(receipts.every((value) => value.ok)).toBe(true);
  expect(receipts.some((value) => value.attempts! > 1)).toBe(true);
  expect((await state(bare)).lastRunId).toBe('10');
  expect((await state(bare, 'drill-race')).lastRunId).toBe('11');
  expect(await count(bare)).toBe(2);
  for (const receipt of receipts) await closed(receipt);
}, 30_000);

it('T3-11 AC-M3-09 수신 불명확한 성공 push를 다시 읽고 같은 관측을 중복 커밋하지 않는다', async () => {
  const { directory, bare } = await setup();
  const receipt = await child(directory, bare, observation('20'), { losePushReply: true });
  expect(receipt).toMatchObject({ ok: true, result: 'skipped', committed: false, attempts: 2 });
  expect(await count(bare)).toBe(1);
  expect((await state(bare)).consecutiveFailures).toBe(1);
  await closed(receipt);
}, 30_000);

it('T3-11 AC-M3-09 읽기 실패를 부재로 바꾸지 않고 원격을 보존한다', async () => {
  const { directory, bare } = await setup();
  const first = await child(directory, bare, observation('30'));
  expect(first.ok).toBe(true);
  await closed(first);
  const failure = await child(directory, bare, observation('31'), { failFetch: true });
  expect(failure.ok).toBe(false);
  expect(failure.commands).toContain('fetch');
  expect(failure.commands).not.toContain('push');
  expect(await count(bare)).toBe(1);
  expect((await state(bare)).lastRunId).toBe('30');
  await closed(failure);
  const missing = await child(directory, join(directory, 'absent.git'), observation('32'));
  expect(missing.ok).toBe(false);
  expect(missing.commands).not.toContain('hash-object');
  await closed(missing);
}, 30_000);

it('T3-11 AC-M3-09 실제 수신 거부 세 번 뒤 실패하며 다른 ref를 만들지 않는다', async () => {
  const { directory, bare } = await setup(),
    rejected = join(directory, 'rejected');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const hook = join(bare, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nprintf reject\\n >> ' + quote(rejected.replaceAll('\\', '/')) + '\nexit 1\n');
  await chmod(hook, 0o700);
  const receipt = await child(directory, bare, observation('40'));
  expect(receipt).toMatchObject({ ok: false, kinds: ['push'] });
  expect(receipt.commands.filter((name) => name === 'push')).toHaveLength(3);
  expect((await readFile(rejected, 'utf8')).match(/reject/g)).toHaveLength(3);
  expect(await git(['--git-dir', bare, 'for-each-ref', '--format=%(refname)'])).toBe('');
  await closed(receipt);
}, 30_000);

it('T3-11 AC-M3-09 못 보낸 항목·실패 횟수·완료를 새 프로세스로 인계한다', async () => {
  const { directory, bare } = await setup();
  for (const run of ['50', '51']) {
    const value = await child(directory, bare, observation(run));
    expect(value.ok).toBe(true);
    await closed(value);
  }
  const id = 'prod:down:51.1';
  const base = { remote: observation('1').remote, stateRef: UPTIME_REF, key: 'prod' };
  const attempt = await child(directory, bare, { ...base, operation: { kind: 'attemptFailure', id, now: NOW + 60 } });
  expect(attempt.state?.pending[0]).toMatchObject({ id, attempts: 1 });
  await closed(attempt);
  const ack = await child(directory, bare, { ...base, operation: { kind: 'ack', id, now: NOW + 61 } });
  expect(ack.state?.pending).toEqual([]);
  expect(ack.state?.lastDelivered?.id).toBe(id);
  await closed(ack);
  const again = await child(directory, bare, { ...base, operation: { kind: 'ack', id, now: NOW + 62 } });
  expect(again).toMatchObject({ ok: true, committed: false, result: 'already_removed', head: ack.head });
  await closed(again);
  expect(await count(bare)).toBe(4);
}, 30_000);

it('T3-11 AC-M3-09 다른 키와 임의 blob을 그대로 이어 쓰며 읽은 커밋을 부모로 삼는다', async () => {
  const { directory, bare } = await setup();
  const first = await child(directory, bare, observation('70', 'drill-keep'));
  expect(first.ok).toBe(true);
  await closed(first);
  const old = await git(['--git-dir', bare, 'rev-parse', UPTIME_REF]);
  const note = join(directory, 'note.txt');
  await writeFile(note, 'preserve this exact blob\n');
  const blob = await git(['--git-dir', bare, 'hash-object', '-w', note]);
  await git(['--git-dir', bare, 'read-tree', old]);
  await git(['--git-dir', bare, 'update-index', '--add', '--cacheinfo', `100644,${blob},other/note.txt`]);
  const tree = await git(['--git-dir', bare, 'write-tree']);
  const seeded = await git([
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '--git-dir',
    bare,
    'commit-tree',
    tree,
    '-p',
    old,
    '-m',
    'preserved fixture',
  ]);
  await git(['--git-dir', bare, 'update-ref', UPTIME_REF, seeded, old]);
  const previous = await git(['--git-dir', bare, 'rev-parse', `${UPTIME_REF}:uptime/drill-keep.json`]);
  const next = await child(directory, bare, observation('71'));
  expect(next.ok).toBe(true);
  await closed(next);
  expect(await git(['--git-dir', bare, 'rev-parse', `${UPTIME_REF}:other/note.txt`])).toBe(blob);
  expect(await git(['--git-dir', bare, 'rev-parse', `${UPTIME_REF}:uptime/drill-keep.json`])).toBe(previous);
  expect(await git(['--git-dir', bare, 'rev-parse', UPTIME_REF + '^'])).toBe(seeded);
}, 30_000);

it('T3-11 AC-M3-09 출력 상한의 원문을 오류에 넣지 않고 자기 자식을 닫는다', async () => {
  const error = await gitProcess(
    ['--eval', 'process.stdout.write("private-output-canary".repeat(100000));setInterval(()=>{},1000)'],
    {
      cwd: root,
      env: process.env,
      command: { file: process.execPath, prefix: [] },
      timeoutMs: 5000,
      graceMs: 100,
    },
  ).then(
    () => null,
    (value: unknown) => value,
  );
  expect(error).toMatchObject({ kind: 'output', cleanupSafe: true });
  expect(String(error)).not.toContain('private-output-canary');
}, 10_000);

it('T3-11 AC-M3-09 상속한 Git TLS·protocol·config·trace를 자기 자식에 넘기지 않는다', async () => {
  const { directory, bare } = await setup(),
    record = join(directory, 'environment.json');
  const receipt = await child(directory, bare, observation('75'), {
    inheritanceCanary: true,
    process: {
      timeoutMs: 5000,
      graceMs: 100,
      command: {
        file: process.execPath,
        prefix: [
          '--import',
          new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href,
          fixture,
          '--environment',
          record,
        ],
      },
    },
  });
  expect(receipt.ok).toBe(false);
  expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({
    sslNoVerify: null,
    allowProtocol: null,
    configCount: null,
    trace: null,
    noSystem: '1',
    globalConfig: '',
    terminalPrompt: '0',
    interactive: 'never',
  });
  await closed(receipt);
  expect(await count(bare)).toBe(0);
}, 15_000);

it('T3-11 AC-M3-09 close를 확인하지 못한 실제 자기 자식의 작업 폴더를 보존한다', async () => {
  const { directory, bare } = await setup(),
    record = join(directory, 'orphan-pids.jsonl');
  let receipt: Receipt | undefined;
  const failures: unknown[] = [];
  try {
    receipt = await child(directory, bare, observation('80'), {
      process: {
        timeoutMs: 2000,
        graceMs: 100,
        command: {
          file: process.execPath,
          prefix: [hangFixture, '--hang-orphan', record],
        },
      },
    });
    expect(receipt).toMatchObject({ ok: false, kinds: ['lifecycle'] });
    expect(receipt.commands).toEqual(['init']);
    expect(receipt.directories).toHaveLength(1);
    expect((await stat(receipt.directories[0]!)).isDirectory()).toBe(true);
    expect(await count(bare)).toBe(0);
  } catch (error) {
    failures.push(error);
  }
  try {
    const rows = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; pid: number; at: number });
    const ready = rows.find((value) => value.kind === '--leaf-ready'),
      exited = rows.find((value) => value.kind === '--parent-exit');
    try {
      expect(ready).toBeDefined();
      expect(exited).toBeDefined();
      expect(exited!.at).toBeGreaterThanOrEqual(ready!.at);
      expect(() => process.kill(exited!.pid, 0)).toThrow();
    } catch (error) {
      failures.push(error);
    }
    for (const row of rows.filter((value) => value.kind === '--hang-leaf')) {
      try {
        process.kill(row.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(error);
      }
      let alive = true;
      for (let index = 0; index < 40; index++) {
        try {
          process.kill(row.pid, 0);
        } catch {
          alive = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (alive) failures.push(new Error('Own orphan fixture process still alive'));
    }
    for (const owned of receipt?.directories ?? []) {
      await removeOwned(owned, 'opensamguk-uptime-git-');
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, 'Body or own orphan cleanup failed');
}, 15_000);

it('T3-11 AC-M3-09 제한을 넘긴 실제 자기 자식·손자를 종료하고 원문 오류를 숨긴다', async () => {
  const { directory } = await setup(),
    record = join(directory, 'pids.jsonl');
  const failures: unknown[] = [];
  try {
    const result = await gitProcess([hangFixture, '--hang-tree', record], {
      cwd: root,
      env: process.env,
      command: { file: process.execPath, prefix: [] },
      timeoutMs: 2000,
      graceMs: 100,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(UptimeGitError);
    expect(result).toMatchObject({ kind: 'timeout', cleanupSafe: true });
    const rows = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; pid: number });
    const records = rows.filter((value) => value.kind === '--hang-tree' || value.kind === '--hang-leaf');
    expect(records).toHaveLength(2);
    for (const { pid } of records) {
      let alive = true;
      for (let index = 0; index < 40; index++) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(alive).toBe(false);
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    const rows = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; pid: number });
    const cleanup = await Promise.allSettled(
      rows
        .filter((value) => value.kind === '--hang-tree' || value.kind === '--hang-leaf')
        .map(async ({ pid }) => {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
          for (let index = 0; index < 40; index++) {
            try {
              process.kill(pid, 0);
            } catch {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error('Own fixture process still alive');
        }),
    );
    failures.push(...cleanup.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])));
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, 'Body or own process cleanup failed');
}, 15_000);
