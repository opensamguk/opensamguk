import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRehearsalStages, rehearsalStoragePath, type RehearsalStageRecord } from './t2-15-month-child';

const tools = dirname(fileURLToPath(import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const container = 'a'.repeat(64);
const system = '1234567890123456789';
const source = `t215_src_${'b'.repeat(32)}_test`;
const target = `t215_dst_${'c'.repeat(32)}_test`;
const binary = Buffer.from([80, 71, 68, 77, 80, 0, 13, 10, 255]);
const migration = '20260101000000_initial';
const checksum = 'd'.repeat(64);
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const roots: string[] = [];
const running = new Set<Promise<unknown>>();

// 운영 슬롯과 T215_* 없이 OS 임시 폴더를 쓰며, 루트 주입은 선택 사항이다.
async function fixture(temporaryRoot = tmpdir()) {
  const root = await mkdtemp(join(temporaryRoot, 't215-unit-'));
  roots.push(root);
  const backup = join(root, 'backup dir');
  const config = join(root, 'docker-config');
  const fakeBin = join(root, 'bin');
  const fake = join(root, 'fake-docker');
  await mkdir(backup);
  await mkdir(config);
  await mkdir(fakeBin);
  const shellRoot = root.replaceAll('\\', '/').replaceAll("'", "'\\''");
  await writeFile(
    fake,
    `#!/usr/bin/env bash
set -euo pipefail
root='${shellRoot}'
printf 'CALL' >>"$root/calls"
printf ' <%s>' "$@" >>"$root/calls"
printf '\\n' >>"$root/calls"
printenv DATABASE_URL PGPASSWORD >>"$root/env" || true
flag() { [[ -f "$root/$1" ]]; }
if [[ "$1" == inspect ]]; then
  if flag bad-container; then printf '%s true\\n' '${'e'.repeat(64)}';
  elif flag stopped; then printf '%s false\\n' '${container}';
  else printf '%s true\\n' '${container}'; fi
  exit 0
fi
[[ "$1" == exec ]]
shift
interactive=false
if [[ "$1" == -i ]]; then interactive=true; shift; fi
[[ "$1" == '${container}' ]]
shift
command=$1; shift
case "$command" in
  pg_dump)
    if [[ "$1" == --version ]]; then
      if flag old-dump; then echo 'pg_dump (PostgreSQL) 16.1'; else echo 'pg_dump (PostgreSQL) 17.2'; fi
    else
      touch "$root/dump-ran"
      if flag dump-fail; then echo 'secret SQL postgres://bad' >&2; exit 1; fi
      if flag dump-empty; then exit 0; fi
      cat "$root/binary"
      if flag terminate-dump; then kill -TERM "$PPID"; sleep 1; fi
    fi;;
  pg_restore)
    case "$1" in
      --version) if flag old-restore; then echo 'pg_restore (PostgreSQL) 16.1'; else echo 'pg_restore (PostgreSQL) 17.2'; fi;;
      --list) [[ "$interactive" == true ]]; cat >"$root/list-stdin"; if flag list-fail; then exit 1; fi;;
      --data-only) [[ "$interactive" == true ]]; cat >"$root/migration-stdin"; if flag migrations-fail; then exit 1; fi; cat "$root/migration-sql";;
      --exit-on-error) [[ "$interactive" == true ]]; cat >"$root/restore-stdin"; if flag restore-fail; then echo 'raw SQL bad' >&2; exit 1; fi;;
      *) exit 1;;
    esac;;
  psql)
    [[ "$interactive" == true ]]
    args=" $* "
    sql=$(cat)
    printf '%s\\n' "$sql" >>"$root/sql"
    printf 'SQL %s\\n' "$(printf '%s\\n' "$sql" | sed -n 's/^-- t215://p')" >>"$root/calls"
    case "$sql" in
      *'-- t215:system'*) if flag bad-system; then echo 987654321; else echo '${system}'; fi;;
      *'-- t215:database-identity'*)
        if [[ "$args" == *' -d ${target} '* ]]; then echo '${target}|101|${system}|170002';
        elif flag bad-source; then echo 'different|100|${system}|170002';
        else echo '${source}|100|${system}|170002'; fi;;
      *'-- t215:quiesced'*) if flag busy; then echo 1; else echo 0; fi;;
      *'-- t215:content'*)
        if flag content-changed && [[ -f "$root/content-read" ]]; then printf 'table\\tWorld\\t2\\tbbbb\\n';
        else printf 'table\\tWorld\\t1\\taaaa\\n'; fi
        touch "$root/content-read";;
      *'-- t215:manifest'*) cat "$root/manifest-header";;
      *'-- t215:retention'*) cat "$root/retention-header";;
      *'-- t215:expected-migrations'*) printf '${migration}\\t${checksum}\\n';;
      *'-- t215:target-migrations'*)
        if flag target-migrations-bad; then printf '20260101000000_other\\t${checksum}\\n';
        else printf '${migration}\\t${checksum}\\n'; fi;;
      *'-- t215:target-oid'*) if flag target-exists || flag created; then echo 101; fi;;
      *'-- t215:target-connections'*) if flag target-busy; then echo 1; else echo 0; fi;;
      *'-- t215:create'*) touch "$root/created";;
      *'-- t215:drop'*) rm -f "$root/created";;
      *) exit 1;;
    esac;;
  *) exit 1;;
esac
`,
    { mode: 0o700 },
  );
  await writeFile(join(root, 'binary'), binary);
  await writeFile(
    join(root, 'migration-sql'),
    `COPY public._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) FROM stdin;\nx\t${checksum}\t2026-01-01\t${migration}\t\\N\t\\N\t2026-01-01\t1\n\\.\n`,
  );
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot,
    PATH: process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin;C:/Program Files/Git/bin' : '/usr/bin:/bin',
    DOCKER_HOST: process.platform === 'win32' ? 'npipe:////./pipe/t215-unit-unused' : 'unix:///t215-unit-unused',
    DOCKER_CONFIG: config,
    HOME: root,
    USERPROFILE: root,
    TEMP: root,
    TMP: root,
    TMPDIR: root,
  };
  async function run(
    script: 'backup' | 'restore',
    args: string[],
    extra: NodeJS.ProcessEnv = {},
    scriptDirectory = tools,
  ) {
    const child = spawn(bash, [join(scriptDirectory, `${script}.sh`), ...args], {
      cwd: root,
      env: { ...env, ...extra },
      shell: false,
      windowsHide: true,
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept({ code, signal }));
    });
    running.add(exited);
    let result;
    try {
      result = await exited;
    } finally {
      running.delete(exited);
    }
    return { ...result, stdout, stderr };
  }
  const common = [
    '--docker',
    fake,
    '--container',
    container,
    '--system-identifier',
    system,
    '--db-user',
    'tester',
    '--admin-db',
    'postgres',
  ];
  const backupArgs = [
    ...common,
    '--release-sha',
    'f'.repeat(40),
    '--source-db',
    source,
    '--backup-dir',
    backup,
    '--reason',
    'rehearsal',
  ];
  async function calls() {
    return readFile(join(root, 'calls'), 'utf8').catch(() => '');
  }
  async function flag(name: string) {
    await writeFile(join(root, name), '1');
  }
  async function failTool(name: 'sha256sum' | 'mv' | 'sync', point: 'hash' | 'dump-mv' | 'manifest-mv' | 'sync') {
    const guard =
      point === 'hash'
        ? `[[ ! -f '${shellRoot}/dump-ran' ]] || exit 1`
        : point === 'dump-mv'
          ? 'for last; do :; done; case "$last" in *.dump) exit 1;; esac'
          : point === 'manifest-mv'
            ? 'for last; do :; done; case "$last" in *.manifest.json) exit 1;; esac'
            : 'exit 1';
    await writeFile(join(fakeBin, name), `#!/usr/bin/env bash\n${guard}\nexec /usr/bin/${name} "$@"\n`, {
      mode: 0o700,
    });
    const toBashPath = (path: string) =>
      path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    const startup = join(root, 'unit-bash-env');
    await writeFile(startup, `export PATH='${toBashPath(fakeBin)}':"$PATH"\n`);
    env.BASH_ENV = toBashPath(startup);
  }
  async function restoreInput(patch: Record<string, unknown> = {}) {
    const data = {
      format: 't215-pg-custom-v1',
      success: true,
      source: { name: source, oid: '100', systemIdentifier: system },
      dumpMajor: 17,
      consistency: 'quiesced',
      sha256: sha(binary),
      size: binary.length,
      contentHash: sha('table\tWorld\t1\taaaa'),
      contentHashReason: 'quiesced',
      releaseSha: 'f'.repeat(40),
      migrations: [{ name: migration, checksum }],
      ...patch,
    };
    const archive = join(backup, 'input.dump'),
      manifest = join(backup, 'input.manifest.json');
    await writeFile(archive, binary);
    await writeFile(manifest, JSON.stringify(data));
    const origin = data.source as { name: string; oid: string; systemIdentifier: string };
    await writeFile(
      join(root, 'manifest-header'),
      [
        origin.name,
        origin.oid,
        origin.systemIdentifier,
        data.dumpMajor,
        data.consistency,
        data.sha256,
        data.contentHash ?? 'null',
        data.contentHashReason,
        data.size,
      ].join('|') + '\n',
    );
    return [...common, '--archive', archive, '--manifest', manifest, '--target-db', target];
  }
  async function oldBackup(days: number) {
    const oldManifest = `backup-20000101t000000z-${'e'.repeat(32)}.manifest.json`;
    const oldDump = oldManifest.replace('.manifest.json', '.dump');
    const createdUnix = Math.floor(Date.now() / 1000) - days * 86400;
    const data = {
      format: 't215-pg-custom-v1',
      success: true,
      source: { name: source, oid: '100', systemIdentifier: system },
      dumpMajor: 17,
      serverVersion: 170002,
      releaseSha: 'f'.repeat(40),
      createdUnix,
      startedUtc: '2000-01-01T00:00:00Z',
      finishedUtc: '2000-01-01T00:00:00Z',
      sha256: sha(binary),
      size: binary.length,
      consistency: 'quiesced',
      contentHash: sha('table\tWorld\t1\taaaa'),
      contentHashReason: 'quiesced',
      externalCopy: 'not-configured',
      migrations: [{ name: migration, checksum }],
    };
    await writeFile(join(backup, oldDump), binary);
    await writeFile(join(backup, oldManifest), JSON.stringify(data));
    await writeFile(join(root, 'retention-header'), `${createdUnix}|${sha(binary)}|${binary.length}\n`);
    return { oldDump, oldManifest };
  }
  return { root, backup, fake, env, run, common, backupArgs, calls, flag, failTool, restoreInput, oldBackup };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled([...running]);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('T2-15 B1 단계 기한과 남은 작업', () => {
  it.each([
    ['E:/owned/t215', 'win32', true],
    ['e:\\owned\\t215', 'win32', true],
    ['C:/owned/t215', 'win32', false],
    ['E:relative', 'win32', false],
    ['/runner-temp/t215', 'linux', true],
    ['runner-temp/t215', 'linux', false],
  ] as const)('소유 임시 경로 %s의 %s 조건을 지킨다', (path, platform, accepted) => {
    expect(rehearsalStoragePath(path, platform)).toBe(accepted);
  });
  const deferred = () => {
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { promise, finish };
  };
  it('끝난 단계만 통과로 기록하고 다음 단계를 시작한다', async () => {
    const controller = new AbortController(),
      rows: RehearsalStageRecord[] = [];
    const stages = createRehearsalStages(controller, (row) => rows.push(row));
    const order: number[] = [];
    await stages.run('one', async () => {
      order.push(1);
    });
    await stages.run('two', async () => {
      order.push(2);
    });
    expect(order).toEqual([1, 2]);
    expect(rows.map((row) => row.status)).toEqual(['passed', 'passed']);
    expect(stages.activeCount).toBe(0);
    await stages.settle();
  });
  it('hook은 20초에 실패를 받고 뒤 7개는 같은 사유로 실패하며 정리는 원래 작업을 기다린다', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(),
      rows: RehearsalStageRecord[] = [],
      gate = deferred();
    const stages = createRehearsalStages(controller, (row) => rows.push(row), { now: () => Date.now() });
    const hook = stages.run('offline', () => gate.promise).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await hook).toBe('stage-deadline');
    expect(controller.signal.aborted).toBe(true);
    expect(stages.activeCount).toBe(1);
    let started = 0;
    for (let index = 0; index < 7; index++)
      await expect(
        stages.run(`case-${index}`, async () => {
          started++;
        }),
      ).rejects.toThrow('stage-deadline');
    expect(started).toBe(0);
    let cleaned = false;
    const cleanup = stages.settle().then(() => {
      cleaned = true;
    });
    await Promise.resolve();
    expect(cleaned).toBe(false);
    gate.finish();
    await cleanup;
    expect(cleaned).toBe(true);
    expect(stages.activeCount).toBe(0);
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.status === 'failed' && row.reason === 'stage-deadline')).toBe(true);
  });
  it('동시에 시작하려는 다음 단계는 실행하지 않고 앞 작업도 abort한다', async () => {
    const controller = new AbortController(),
      rows: RehearsalStageRecord[] = [],
      gate = deferred();
    const stages = createRehearsalStages(controller, (row) => rows.push(row));
    const first = stages.run('first', () => gate.promise).catch((error: Error) => error.message);
    await Promise.resolve();
    let started = false;
    await expect(
      stages.run('second', async () => {
        started = true;
      }),
    ).rejects.toThrow('previous-stage-active');
    expect(started).toBe(false);
    expect(await first).toBe('previous-stage-active');
    gate.finish();
    await stages.settle();
    expect(rows.every((row) => row.status === 'failed')).toBe(true);
  });
  it('timer callback이 늦어도 기한 뒤 완료를 통과로 기록하지 않는다', async () => {
    let clock = 0;
    const controller = new AbortController(),
      rows: RehearsalStageRecord[] = [];
    const stages = createRehearsalStages(controller, (row) => rows.push(row), { now: () => clock });
    await expect(
      stages.run('late', async () => {
        clock = 20_001;
      }),
    ).rejects.toThrow('stage-deadline');
    expect(rows[0]).toMatchObject({ status: 'failed', reason: 'stage-deadline', elapsedMs: 20_001 });
    await stages.settle();
  });
  it('작업 실패의 고정 사유를 보존하고 다음 작업은 실행하지 않는다', async () => {
    const controller = new AbortController(),
      rows: RehearsalStageRecord[] = [];
    const stages = createRehearsalStages(controller, (row) => rows.push(row), { reasonOf: () => 'fixture-failed' });
    await expect(
      stages.run('first', async () => {
        throw new Error('private-error-marker');
      }),
    ).rejects.toThrow('fixture-failed');
    await expect(
      stages.run('next', async () => {
        throw new Error('must-not-start');
      }),
    ).rejects.toThrow('fixture-failed');
    expect(JSON.stringify(rows)).not.toMatch(/private-error-marker|must-not-start/);
    await stages.settle();
  });
  it('취소된 작업의 늦은 완료도 정리 전에 기다린다', async () => {
    const controller = new AbortController(),
      rows: RehearsalStageRecord[] = [],
      gate = deferred();
    const stages = createRehearsalStages(controller, (row) => rows.push(row));
    const first = stages.run('cancelled', () => gate.promise).catch((error: Error) => error.message);
    await Promise.resolve();
    controller.abort();
    expect(await first).toBe('aborted');
    let cleaned = false;
    const cleanup = stages.settle().then(() => {
      cleaned = true;
    });
    await Promise.resolve();
    expect(cleaned).toBe(false);
    gate.finish();
    await cleanup;
    expect(cleaned).toBe(true);
    expect(rows[0]?.status).toBe('failed');
  });
});

describe('T2-15 B1 백업·복구 경계', () => {
  it('스크립트 줄끝은 LF다', async () => {
    for (const file of ['backup.sh', 'restore.sh'])
      expect((await readFile(join(tools, file))).includes(13)).toBe(false);
  });
  it.each(['backup', 'restore'] as const)('%s 필수 인자가 없으면 docker를 부르지 않는다', async (script) => {
    const f = await fixture();
    const args = script === 'backup' ? f.backupArgs : await f.restoreInput();
    for (let index = 0; index < args.length; index += 2) {
      const result = await f.run(script, [...args.slice(0, index), ...args.slice(index + 2)]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('ARGUMENT');
    }
    expect(await f.calls()).toBe('');
  });
  it.each(['tcp://127.0.0.1:2375', 'ssh://remote', 'https://remote', ''])(
    '원격·빈 daemon %s는 호출 전에 거부한다',
    async (host) => {
      const f = await fixture();
      expect((await f.run('backup', f.backupArgs, { DOCKER_HOST: host })).code).not.toBe(0);
      expect(await f.calls()).toBe('');
    },
  );
  it.each(['short', 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)])(
    '잘못된 release SHA %s는 docker·파일 생성 전에 거부한다',
    async (release) => {
      const f = await fixture();
      const args = [...f.backupArgs];
      args[args.indexOf('--release-sha') + 1] = release;
      expect((await f.run('backup', args)).stderr).toContain('RELEASE_SHA_ARGUMENT');
      expect(await f.calls()).toBe('');
      expect(await readdir(f.backup)).toEqual([]);
    },
  );
  it('Bash 안에서 만든 개행 포함 release SHA도 거부한다', async () => {
    const f = await fixture();
    const bridge = join(f.root, 'newline-input');
    await mkdir(bridge);
    const original = join(tools, 'backup.sh').replaceAll('\\', '/').replaceAll("'", "'\\''");
    // Windows native argv 경계가 개행을 지울 수 있어 Bash 안에서 입력을 만든다.
    await writeFile(
      join(bridge, 'backup.sh'),
      `#!/usr/bin/env bash\nsource '${original}'\nt215_backup_main "$@" --release-sha '${'a'.repeat(40)}\n'\n`,
    );
    const args = [...f.backupArgs];
    args.splice(args.indexOf('--release-sha'), 2);
    const result = await f.run('backup', args, {}, bridge);
    expect(result.stderr).toContain('RELEASE_SHA_ARGUMENT');
    expect(await f.calls()).toBe('');
    expect(await readdir(f.backup)).toEqual([]);
  });
  it('Git 없는 archive 사본에서도 명시한 release SHA를 그대로 기록한다', async () => {
    const f = await fixture();
    const archiveTools = join(f.root, 'archive', 'tools');
    await mkdir(archiveTools, { recursive: true });
    await writeFile(join(archiveTools, 'backup.sh'), await readFile(join(tools, 'backup.sh')));
    const args = [...f.backupArgs],
      release = 'F'.repeat(40);
    args[args.indexOf('--release-sha') + 1] = release;
    const result = await f.run('backup', args, {}, archiveTools);
    expect(result.code, result.stderr).toBe(0);
    const files = await readdir(f.backup);
    const receipt = JSON.parse(
      await readFile(
        join(
          f.backup,
          files.find((name) => name.endsWith('.manifest.json'))!,
        ),
        'utf8',
      ),
    );
    expect(receipt.releaseSha).toBe(release);
  });
  it.each(['bad-container', 'stopped', 'bad-system', 'bad-source', 'old-dump', 'busy'])(
    'backup 사전 거부 %s는 dump 0회다',
    async (flag) => {
      const f = await fixture();
      await f.flag(flag);
      expect((await f.run('backup', f.backupArgs)).code).not.toBe(0);
      expect(await f.calls()).not.toContain('<-Fc>');
      expect((await readdir(f.backup)).filter((n) => n.endsWith('.dump') || n.endsWith('.json'))).toEqual([]);
    },
  );
  it('남의 잠금은 지우지 않는다', async () => {
    const f = await fixture();
    await mkdir(join(f.backup, '.t215.lock'));
    expect((await f.run('backup', f.backupArgs)).stderr).toContain('LOCKED');
    expect(await readdir(f.backup)).toContain('.t215.lock');
    expect(await f.calls()).toBe('');
  });
  it('daily 백업은 writer를 막지 않고 내용 해시를 비워 둔다', async () => {
    const f = await fixture();
    await f.flag('busy');
    const args = [...f.backupArgs];
    args[args.length - 1] = 'daily';
    const result = await f.run('backup', args);
    expect(result.code, result.stderr).toBe(0);
    const files = await readdir(f.backup);
    const data = JSON.parse(
      await readFile(
        join(
          f.backup,
          files.find((name) => name.endsWith('.manifest.json'))!,
        ),
        'utf8',
      ),
    );
    expect(data.consistency).toBe('live');
    expect(data.contentHash).toBeNull();
    expect(data.contentHashReason).toBe('live-source');
    expect(await f.calls()).not.toMatch(/SQL (?:quiesced|content)/);
  });
  it('live 복원은 migration을 대조하고 내용 해시를 비교하지 않는다', async () => {
    const f = await fixture();
    await f.flag('busy');
    const result = await f.run(
      'restore',
      await f.restoreInput({ consistency: 'live', contentHash: null, contentHashReason: 'live-source' }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(await f.calls()).toContain('SQL target-migrations');
    expect(await f.calls()).not.toMatch(/SQL (?:quiesced|content)/);
  });
  it('공백 경로의 바이너리와 명시적 docker 인자를 보존한다', async () => {
    const f = await fixture();
    const result = await f.run('backup', f.backupArgs, { COMPOSE_FILE: 'ignore.yml', COMPOSE_PROJECT_NAME: 'ignored' });
    expect(result.code, result.stderr).toBe(0);
    const files = await readdir(f.backup),
      dump = files.find((n) => n.endsWith('.dump'))!;
    expect(await readFile(join(f.backup, dump))).toEqual(binary);
    expect(await readFile(join(f.root, 'list-stdin'))).toEqual(binary);
    const calls = await f.calls();
    expect(calls).not.toMatch(/<(?:compose|run|start|stop|rm|cp|pull|build|volume|network|-t|-e|--env|-u)>/);
    for (const call of calls.split('\n').filter((s) => s.startsWith('CALL'))) {
      expect(call).toMatch(/^CALL <(?:inspect|exec)>/);
      expect(call).toContain(`<${container}>`);
    }
    expect(
      await readFile(
        join(
          f.backup,
          files.find((n) => n.endsWith('.manifest.json'))!,
        ),
        'utf8',
      ),
    ).toContain('not-configured');
    expect(files.some((n) => n.startsWith('.partial-'))).toBe(false);
  });
  it.each(['dump-fail', 'dump-empty', 'list-fail', 'migrations-fail', 'content-changed', 'terminate-dump'])(
    'dump 뒤 실패 %s는 성공 manifest와 남의 파일을 건드리지 않는다',
    async (flag) => {
      const f = await fixture();
      await f.flag(flag);
      await writeFile(join(f.backup, 'other.dump'), binary);
      await writeFile(join(f.backup, '.partial-other.dump'), binary);
      const result = await f.run('backup', f.backupArgs);
      expect(result.code).not.toBe(0);
      expect((await f.calls()).match(/<-Fc>/g)?.length).toBe(1);
      expect((await readdir(f.backup)).sort()).toEqual(['.partial-other.dump', 'other.dump']);
      expect(await readFile(join(f.backup, 'other.dump'))).toEqual(binary);
      expect(result.stdout + result.stderr).not.toContain('secret SQL');
    },
  );
  it.each([
    ['sha256sum', 'hash'],
    ['mv', 'dump-mv'],
    ['mv', 'manifest-mv'],
    ['sync', 'sync'],
  ] as const)('dump 뒤 도구 %s의 %s 실패는 성공 manifest가 없다', async (tool, point) => {
    const f = await fixture();
    await f.failTool(tool, point);
    await writeFile(join(f.backup, 'other.dump'), binary);
    const result = await f.run('backup', f.backupArgs);
    expect(result.code).not.toBe(0);
    expect((await f.calls()).match(/<-Fc>/g)?.length).toBe(1);
    const files = await readdir(f.backup);
    expect(files.filter((name) => name.endsWith('.manifest.json'))).toEqual([]);
    expect(files.some((name) => name.startsWith('.partial-'))).toBe(false);
    expect(await readFile(join(f.backup, 'other.dump'))).toEqual(binary);
    expect(files.filter((name) => name.startsWith('backup-') && name.endsWith('.dump')).length).toBe(
      point === 'manifest-mv' ? 1 : 0,
    );
  });
  it.each([6, 8])('성공 백업의 보관 기간 %i일을 지킨다', async (days) => {
    const f = await fixture();
    const { oldManifest, oldDump } = await f.oldBackup(days);
    expect((await f.run('backup', f.backupArgs)).code).toBe(0);
    const remaining = await readdir(f.backup);
    expect(remaining.includes(oldManifest)).toBe(days <= 7);
    expect(remaining.includes(oldDump)).toBe(days <= 7);
  });
  it('실패한 실행은 오래된 성공 백업을 보관 삭제하지 않는다', async () => {
    const f = await fixture();
    await f.oldBackup(8);
    const before = await readdir(f.backup);
    await f.flag('dump-fail');
    expect((await f.run('backup', f.backupArgs)).code).not.toBe(0);
    expect(await readdir(f.backup)).toEqual(before);
  });
  it.each(['UPPER_test', 'bad;drop_test', 'bad"test', 'x'.repeat(64), 't215_dst_abc_testfixture'])(
    '허용식 밖 대상 %s는 CREATE 전에 거부한다',
    async (name) => {
      const f = await fixture();
      const args = await f.restoreInput();
      args[args.length - 1] = name;
      expect((await f.run('restore', args)).code).not.toBe(0);
      expect(await f.calls()).toBe('');
    },
  );
  it.each(['target-exists', 'list-fail', 'old-restore'])(
    'restore 사전 거부 %s는 CREATE·복원·DROP 0회다',
    async (flag) => {
      const f = await fixture();
      const args = await f.restoreInput();
      await f.flag(flag);
      expect((await f.run('restore', args)).code).not.toBe(0);
      expect(await f.calls()).not.toMatch(/SQL (?:create|drop)|<--exit-on-error>|<-Fc>/);
    },
  );
  it.each([
    { sha256: '0'.repeat(64) },
    { source: { name: target, oid: '100', systemIdentifier: system } },
    { source: { name: source, oid: '100', systemIdentifier: '999' } },
    { contentHash: null },
    { consistency: 'live', contentHashReason: 'live-source' },
  ])('manifest 경계 %j는 CREATE 전에 거부한다', async (patch) => {
    const f = await fixture();
    const args = await f.restoreInput(patch);
    expect((await f.run('restore', args)).code).not.toBe(0);
    expect(await f.calls()).not.toMatch(/SQL (?:create|drop)|<--exit-on-error>|<-Fc>/);
  });
  it('restore stdin은 원본 바이트이고 성공 뒤 대상은 남긴다', async () => {
    const f = await fixture();
    const result = await f.run('restore', await f.restoreInput());
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(join(f.root, 'restore-stdin'))).toEqual(binary);
    expect(await f.calls()).toContain('SQL create');
    expect(await f.calls()).not.toContain('SQL drop');
  });
  it.each(['restore-fail', 'target-migrations-bad'])(
    'CREATE 뒤 %s는 같은 OID·연결 0인 자기 대상만 정리한다',
    async (flag) => {
      const f = await fixture();
      const args = await f.restoreInput();
      await f.flag(flag);
      expect((await f.run('restore', args)).code).not.toBe(0);
      expect(await f.calls()).toContain('SQL create');
      expect(await f.calls()).toContain('SQL drop');
    },
  );
  it('CREATE 뒤 연결이 남은 대상은 강제 삭제하지 않는다', async () => {
    const f = await fixture();
    const args = await f.restoreInput();
    await f.flag('restore-fail');
    await f.flag('target-busy');
    const result = await f.run('restore', args);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('CLEANUP_RETAINED');
    expect(await f.calls()).not.toContain('SQL drop');
  });
  it('부모 비밀 환경과 자식 오류는 출력·호출·환경 기록에 남지 않는다', async () => {
    const f = await fixture();
    await f.flag('dump-fail');
    const secret = 't215-secret-marker-891';
    await writeFile(join(f.root, 'secret-file'), secret);
    const result = await f.run('backup', f.backupArgs, { DATABASE_URL: `postgresql://${secret}`, PGPASSWORD: secret });
    expect(result.code).not.toBe(0);
    expect(
      result.stdout + result.stderr + (await f.calls()) + (await readFile(join(f.root, 'env'), 'utf8')),
    ).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toMatch(/raw SQL|postgres:\/\//);
    expect(await readFile(join(f.root, 'secret-file'), 'utf8')).toBe(secret);
  });
  it('외부 루트 주입은 선택 사항이다', async () => {
    const f = await fixture();
    const nested = await fixture(f.root);
    expect(resolve(nested.root).startsWith(resolve(f.root))).toBe(true);
  });
});
