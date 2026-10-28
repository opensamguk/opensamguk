import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, expect, it as registeredTest } from 'vitest';
import { nodeCli } from '../node-cli';
import { UPTIME_REF } from './uptimeGit';
import { gitProcess } from './uptimeGitProcess';
import type { UptimeRunConfig } from './uptimeRun';
import { initialState, observe, serializeState, type UptimeState } from './uptimeState';

const exec = promisify(execFile),
  root = fileURLToPath(new URL('../../', import.meta.url)),
  cli = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
  fixture = fileURLToPath(new URL('../fixtures/uptime-run-child.ts', import.meta.url));
const pending = new Set<Promise<void>>(),
  folders: string[] = [],
  servers: Server[] = [];
function it(name: string, body: () => Promise<void>) {
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
    30000,
  );
}
async function git(args: string[]) {
  return (
    await exec('git', args, {
      cwd: root,
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  ).stdout.trimEnd();
}
type Receipt = {
  ok: boolean;
  kind?: string;
  warnings?: { code: string; reason?: string }[];
  result?: {
    mode: string;
    observation?: string;
    delivered?: number;
    pending?: number;
    warnings?: { code: string; reason?: string }[];
  };
  commands: string[];
  directories: string[];
  sent: { id: string; persisted: boolean }[];
  operations: number;
  probes: number;
};
const configuration: UptimeRunConfig = {
  stateRef: UPTIME_REF,
  publicUrl: 'https://game.example.invalid',
  remote: 'https://example.invalid/repository.git',
  key: 'prod',
  runId: '1',
  runAttempt: '1',
  webhook: 'https://discord.com/api/webhooks/123/fixture-webhook-private-canary',
};
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'opensamguk-uptime-run-test-'));
  folders.push(directory);
  const bare = join(directory, 'remote.git');
  await git(['init', '--bare', '--quiet', bare]);
  const controls = {
    health: 500,
    receiver: 204 as number | 'disconnect',
    requests: 0,
    messages: [] as { id: string; kind: string }[],
    errors: [] as unknown[],
  };
  const server = createServer((request, response) => {
    controls.requests++;
    if (request.url === '/healthz' || request.url === '/healthz/engine') {
      response.statusCode = controls.health;
      response.end('private-health-canary');
      return;
    }
    let raw = '';
    request.on('data', (chunk) => (raw += String(chunk)));
    request.on('end', () => {
      try {
        expect(request.url).toBe('/receiver?wait=true');
        expect(request.method).toBe('POST');
        const body = JSON.parse(raw) as { content: string; allowed_mentions: unknown };
        expect(body.allowed_mentions).toEqual({ parse: [] });
        const lines = body.content.split('\n');
        controls.messages.push({ kind: lines[0]!, id: lines[1]! });
        if (controls.receiver === 'disconnect') {
          response.destroy();
          return;
        }
        response.statusCode = controls.receiver;
        response.end('private-receiver-canary');
      } catch (error) {
        controls.errors.push(error);
        response.statusCode = 500;
        response.end();
      }
    });
  });
  servers.push(server);
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      server.listen(randomInt(10081, 65536), '127.0.0.1');
      await once(server, 'listening');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Own HTTP bind failed');
  const url = `http://127.0.0.1:${address.port}`;
  let sequence = 0;
  const run = async (runId: string, patch: Partial<UptimeRunConfig> = {}, options: Record<string, unknown> = {}) => {
    const config = { ...configuration, runId, ...patch },
      path = join(directory, 'input-' + crypto.randomUUID() + '.json');
    await writeFile(
      path,
      JSON.stringify({
        config,
        localRemote: bare,
        healthUrl: url,
        receiverUrl: url + '/receiver',
        now: Date.UTC(2026, 9, 29) + sequence++ * 1000,
        ...options,
      }),
      { flag: 'wx' },
    );
    const [file, args] = nodeCli(cli, [fixture, path]);
    const result = await gitProcess(args, {
      cwd: root,
      env: process.env,
      command: { file, prefix: [] },
      timeoutMs: 30000,
      graceMs: 1000,
    });
    expect(
      result.stdout.includes('private-canary') ||
        result.stdout.includes('private-health-canary') ||
        result.stdout.includes('private-receiver-canary'),
    ).toBe(false);
    const receipt = JSON.parse(result.stdout) as Receipt;
    expect(result.code).toBe(receipt.ok ? 0 : 1);
    for (const folder of receipt.directories) await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(controls.errors).toHaveLength(0);
    return receipt;
  };
  return {
    directory,
    bare,
    controls,
    run,
    seedFour: async () => {
      let state = initialState();
      for (const [index, ok] of [false, false, true, false, false, true].entries())
        state = observe(state, {
          key: 'prod',
          runId: String(index + 1),
          runAttempt: '1',
          now: Date.UTC(2026, 9, 29) + (index + 1) * 1000,
          ok,
          webhookConfigured: true,
        }).state;
      expect(state.pending).toHaveLength(4);
      const source = join(directory, 'seed'),
        hooks = join(directory, 'empty-hooks');
      await mkdir(join(source, 'uptime'), { recursive: true });
      await mkdir(hooks);
      await git(['init', '--quiet', source]);
      await writeFile(join(source, 'uptime', 'prod.json'), serializeState(state));
      await git(['-C', source, 'add', '--', 'uptime/prod.json']);
      await git([
        '-C',
        source,
        '-c',
        'core.hooksPath=' + hooks,
        '-c',
        'user.name=Uptime fixture',
        '-c',
        'user.email=uptime-fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'seed pending',
      ]);
      await git(['-C', source, '-c', 'core.hooksPath=' + hooks, 'push', '--quiet', bare, `HEAD:${UPTIME_REF}`]);
      return state;
    },
    state: async (key = 'prod') =>
      JSON.parse(await git(['--git-dir', bare, 'show', `${UPTIME_REF}:uptime/${key}.json`])) as UptimeState,
    count: async () => {
      const exists = await git(['--git-dir', bare, 'for-each-ref', '--format=%(objectname)', UPTIME_REF]);
      return exists ? Number(await git(['--git-dir', bare, 'rev-list', '--count', UPTIME_REF])) : 0;
    },
  };
}
afterAll(async () => {
  const body = await Promise.allSettled([...pending]);
  const closed = await Promise.allSettled(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  const removed = await Promise.allSettled(
    folders.map(async (directory) => {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(basename(directory).startsWith('opensamguk-uptime-run-test-')).toBe(true);
      await rm(directory, { recursive: true, maxRetries: process.platform === 'win32' ? 10 : 0, retryDelay: 50 });
    }),
  );
  const failures = [...body, ...closed, ...removed].flatMap((item) =>
    item.status === 'rejected' ? [item.reason] : [],
  );
  if (failures.length) throw new AggregateError(failures, 'Own run fixtures body or cleanup failed');
}, 120000);

it('T3-11 AC-M3-09 ref 우선 거부·disabled와 잘못된 활성 설정은 Git/HTTP0건이다', async () => {
  const f = await setup();
  for (const patch of [
    { stateRef: 'refs/heads/main', publicUrl: '' },
    { publicUrl: 'http://game.example.invalid' },
    { publicUrl: 'https://game.example.invalid/path' },
    { remote: 'https://user:fixture-private-canary@example.invalid/repo' },
    { webhook: 'https://example.invalid/api/webhooks/123/fixture-private-canary' },
    { runId: 1 as unknown as string },
  ]) {
    const receipt = await f.run('1', patch);
    expect(receipt).toMatchObject({ ok: false, kind: 'configuration', commands: [], operations: 0, probes: 0 });
  }
  expect(await f.run('1', { publicUrl: '', remote: 'invalid', webhook: 'invalid' })).toMatchObject({
    ok: true,
    result: { mode: 'disabled' },
    commands: [],
    operations: 0,
    probes: 0,
  });
  expect(f.controls.requests).toBe(0);
  expect(await f.count()).toBe(0);
});

it('T3-11 AC-M3-09 실제 두 실패·장애·회복·중복·옛 실행과 분리 키를 새 프로세스에서 잇는다', async () => {
  const f = await setup();
  expect(await f.run('1')).toMatchObject({ ok: true, result: { observation: 'applied', delivered: 0 } });
  const second = await f.run('2');
  expect(second).toMatchObject({
    ok: true,
    result: { delivered: 1, pending: 0 },
    sent: [{ id: 'prod:down:2.1', persisted: true }],
  });
  expect(await f.count()).toBe(3);
  expect(await f.run('2')).toMatchObject({ ok: true, result: { observation: 'skipped', delivered: 0 } });
  f.controls.health = 200;
  expect(await f.run('3')).toMatchObject({
    ok: true,
    result: { delivered: 1, pending: 0 },
    sent: [{ id: 'prod:recovery:3.1', persisted: true }],
  });
  expect(await f.run('1')).toMatchObject({ ok: true, result: { observation: 'skipped', delivered: 0 } });
  const prod = await f.state();
  f.controls.health = 500;
  expect(await f.run('4', { key: 'drill-separated' })).toMatchObject({ ok: true, result: { delivered: 0 } });
  expect(await f.state()).toEqual(prod);
  expect(f.controls.messages.map((row) => row.id)).toEqual(['prod:down:2.1', 'prod:recovery:3.1']);
  expect(await f.count()).toBe(6);
});

it('T3-11 AC-M3-09 실제 수신 실패는 attempts를 기록하고 재시작 뒤 같은 ID와 회복을 FIFO로 보낸다', async () => {
  const f = await setup();
  await f.run('1');
  f.controls.receiver = 503;
  expect(await f.run('2')).toMatchObject({
    ok: false,
    kind: 'delivery',
    sent: [{ id: 'prod:down:2.1', persisted: true }],
  });
  expect((await f.state()).pending[0]).toMatchObject({ id: 'prod:down:2.1', attempts: 1 });
  expect(await f.count()).toBe(3);
  f.controls.health = 200;
  f.controls.receiver = 204;
  expect(await f.run('3')).toMatchObject({
    ok: true,
    result: { delivered: 2, pending: 0 },
    sent: [
      { id: 'prod:down:2.1', persisted: true },
      { id: 'prod:recovery:3.1', persisted: true },
    ],
  });
  expect(f.controls.messages.map((row) => row.id)).toEqual(['prod:down:2.1', 'prod:down:2.1', 'prod:recovery:3.1']);
  expect(await f.count()).toBe(6);
});

it('T3-11 AC-M3-09 실제 ack push 응답 유실은 다시 읽어 중복 커밋·동일 실행 재전송을 막는다', async () => {
  const f = await setup();
  await f.run('1');
  expect(await f.run('2', {}, { loseAckReply: true })).toMatchObject({
    ok: true,
    result: { delivered: 1, pending: 0 },
    sent: [{ id: 'prod:down:2.1', persisted: true }],
  });
  expect(await f.count()).toBe(3);
  expect(await f.run('2')).toMatchObject({ ok: true, result: { observation: 'skipped', delivered: 0 } });
  expect(f.controls.messages).toHaveLength(1);
});

it('T3-11 AC-M3-09 실제 수신 뒤 ack push3회 거절은 pending을 보존하고 뒤 항목을 보내지 않는다', async () => {
  const f = await setup();
  await f.run('1');
  f.controls.receiver = 503;
  await f.run('2');
  f.controls.health = 200;
  await f.run('3');
  const before = await f.state();
  expect(before.pending.map((item) => item.id)).toEqual(['prod:down:2.1', 'prod:recovery:3.1']);
  f.controls.receiver = 204;
  const hook = join(f.bare, 'hooks', 'pre-receive');
  await writeFile(
    hook,
    '#!/bin/sh\nwhile read old new ref; do\n message=$(git log -1 --format=%s "$new") || exit 2\n case "$message" in *" ack") printf "rejected\\n" >> "$GIT_DIR/ack-rejected"; exit 1;; esac\ndone\n',
  );
  await chmod(hook, 0o700);
  expect(await f.run('3')).toMatchObject({ ok: false, kind: 'git', sent: [{ id: 'prod:down:2.1', persisted: true }] });
  expect(await f.state()).toEqual(before);
  expect(f.controls.messages).toHaveLength(3);
  expect(f.controls.messages.some((row) => row.id === 'prod:recovery:3.1')).toBe(false);
  expect((await readFile(join(f.bare, 'ack-rejected'), 'utf8')).trim().split('\n')).toHaveLength(3);
  await rm(hook);
  expect(await f.run('3')).toMatchObject({
    ok: true,
    result: { delivered: 2, pending: 0 },
    sent: [
      { id: 'prod:down:2.1', persisted: true },
      { id: 'prod:recovery:3.1', persisted: true },
    ],
  });
  expect(f.controls.messages.map((row) => row.id)).toEqual([
    'prod:down:2.1',
    'prod:down:2.1',
    'prod:down:2.1',
    'prod:down:2.1',
    'prod:recovery:3.1',
  ]);
});

it('T3-11 AC-M3-09 상한으로 버린 항목은 실제 전달 실패 결과에도 안전한 경고를 남긴다', async () => {
  const f = await setup();
  await f.seedFour();
  f.controls.receiver = 503;
  await f.run('7', {}, { now: Date.UTC(2026, 9, 29) + 7000 });
  const result = await f.run('8', {}, { now: Date.UTC(2026, 9, 29) + 8000 });
  expect(result).toMatchObject({ ok: false, kind: 'delivery', warnings: [{ code: 'pending_dropped', reason: 'cap' }] });
  expect((await f.state()).pending.map((item) => item.id)).toEqual([
    'prod:recovery:3.1',
    'prod:down:5.1',
    'prod:recovery:6.1',
    'prod:down:8.1',
  ]);
});

it('T3-11 AC-M3-09 실제 판정 push 응답이 유실돼도 확정 이력의 TTL 경고를 보존한다', async () => {
  const f = await setup();
  await f.seedFour();
  const result = await f.run('7', {}, { now: Date.UTC(2026, 9, 30, 1), loseObserveReply: true });
  expect(result).toMatchObject({ ok: true, result: { observation: 'skipped', delivered: 0, pending: 0 }, sent: [] });
  expect(result.result?.warnings?.filter((item) => item.code === 'pending_dropped')).toEqual(
    Array.from({ length: 4 }, () => ({ code: 'pending_dropped', reason: 'ttl' })),
  );
  expect(await f.count()).toBe(2);
  expect(f.controls.messages).toHaveLength(0);
});

it('T3-11 AC-M3-09 실제 원격 읽기 오류는 기존 pending도 보내지 않는다', async () => {
  const f = await setup();
  await f.run('1');
  f.controls.receiver = 503;
  await f.run('2');
  const before = await f.state(),
    count = await f.count(),
    received = f.controls.messages.length;
  f.controls.receiver = 204;
  expect(await f.run('3', {}, { failRead: true })).toMatchObject({ ok: false, kind: 'git', sent: [] });
  expect(await f.state()).toEqual(before);
  expect(await f.count()).toBe(count);
  expect(f.controls.messages).toHaveLength(received);
});

it('T3-11 AC-M3-09 시각 역행과 기한 지난 옛 실행은 pending을 전송하지 않는다', async () => {
  const f = await setup();
  await f.run('1');
  f.controls.receiver = 503;
  await f.run('2');
  const before = await f.state(),
    count = await f.count(),
    received = f.controls.messages.length;
  f.controls.receiver = 204;
  expect(await f.run('3', {}, { now: Date.UTC(2026, 9, 28) })).toMatchObject({ ok: false, kind: 'git', sent: [] });
  expect(await f.run('1', {}, { now: Date.UTC(2026, 9, 30, 1) })).toMatchObject({
    ok: true,
    result: { observation: 'skipped', delivered: 0, pending: 1 },
    sent: [],
  });
  expect(await f.state()).toEqual(before);
  expect(await f.count()).toBe(count);
  expect(f.controls.messages).toHaveLength(received);
});
