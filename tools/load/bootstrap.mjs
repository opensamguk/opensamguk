// AC-M3-07. 의존성 설치 전 실행하므로 Node 내장 모듈만 사용한다.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readlink, realpath, statfs, mkdir, writeFile } from 'node:fs/promises';
import { posix, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { snapshotSource } from './source-snapshot.mjs';

// 설치 후 동결된 docker.ts/admission.ts와 동일성 시험을 한다. 여기서 새 기본값을 추정하지 않는다.
export const BOOTSTRAP_DOCKER = Object.freeze({
  endpoint: 'unix:///var/run/docker.sock',
  cgroupParent: 'system.slice',
  cgroupPath: '/sys/fs/cgroup/system.slice',
});
export const BUILD_BUDGET = Object.freeze({ cpu: 1, memoryBytes: 2 * 1024 ** 3, diskBytes: 4 * 1024 ** 3 });
export const BOOTSTRAP_LIMIT_MS = 300_000;

const diagnosticPhases = new Set([
  'platform',
  'source',
  'docker',
  'admission-window',
  'admission-counters',
  'admission-parse',
  'admission-cgroups',
  'admission-decision',
  'install-scope',
  'install',
  'scope-proof',
  'source-proof',
  'publish',
]);
const diagnosticCodes = new Set([
  'LOAD_BOOTSTRAP_PLATFORM_UNVERIFIED',
  'LOAD_BOOTSTRAP_SOURCE_INVALID',
  'LOAD_BOOTSTRAP_OPTIONS_INVALID',
  'LOAD_DISPATCH_SOURCE_INVALID',
  'LOAD_LOCAL_DOCKER_REQUIRED',
  'LOAD_BOOTSTRAP_DAEMON_UNVERIFIED',
  'LOAD_BOOTSTRAP_SAMPLE_INVALID',
  'LOAD_BOOTSTRAP_ADMISSION_REFUSED',
  'LOAD_INSTALL_SCOPE_EXISTS',
  'LOAD_INSTALL_SCOPE_UNVERIFIED',
  'LOAD_INSTALL_TOOL_UNVERIFIED',
  'LOAD_BOOTSTRAP_NATIVE_UNCONFIRMED',
  'LOAD_BOOTSTRAP_SOURCE_CHANGED',
]);
const diagnosticReasons = new Set(['sample_invalid', 'cpu_limit', 'memory_limit', 'cgroup_headroom', 'disk_reserve']);

// 공개 실패 진단에는 고정 분류만 쓴다. 원문 오류·경로·환경·native 출력은 싣지 않는다.
export function bootstrapDiagnostic(phase, error, admissionReason) {
  return {
    phase: diagnosticPhases.has(phase) ? phase : 'unknown',
    code:
      error instanceof Error && diagnosticCodes.has(error.message)
        ? error.message
        : error?.code === 'ENOENT'
          ? 'RESOURCE_MISSING'
          : error?.code === 'EACCES' || error?.code === 'EPERM'
            ? 'RESOURCE_DENIED'
            : 'UNCLASSIFIED',
    admissionReason: diagnosticReasons.has(admissionReason) ? admissionReason : null,
  };
}

// 자식 stderr에서는 우리가 만든 고정 진단 한 줄만 받아 다시 구성한다.
export function parseBootstrapDiagnostic(line) {
  if (typeof line !== 'string' || line.length > 4096) return null;
  try {
    const value = JSON.parse(line);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'admissionReason,cleanupFailed,code,event,innerDiagnostic,pending,phase,scopeAttempted,scopeClosed' ||
      value.event !== 'LOAD_BOOTSTRAP_DIAGNOSTIC' ||
      value.innerDiagnostic !== null ||
      !(diagnosticPhases.has(value.phase) || value.phase === 'unknown') ||
      !(
        diagnosticCodes.has(value.code) || ['RESOURCE_MISSING', 'RESOURCE_DENIED', 'UNCLASSIFIED'].includes(value.code)
      ) ||
      !(value.admissionReason === null || diagnosticReasons.has(value.admissionReason)) ||
      typeof value.scopeAttempted !== 'boolean' ||
      typeof value.scopeClosed !== 'boolean' ||
      typeof value.cleanupFailed !== 'boolean' ||
      !Number.isSafeInteger(value.pending) ||
      value.pending < 0
    )
      return null;
    return { phase: value.phase, code: value.code, admissionReason: value.admissionReason };
  } catch {
    return null;
  }
}

export function bootstrapReason(sample, options) {
  const cpuPercent = options.cpuPercent ?? 80,
    memoryPercent = options.memoryPercent ?? 80,
    reserve = (options.diskReserveMiB ?? 2048) * 1024 ** 2;
  const values = [
    sample.at,
    sample.cpuWindowMs,
    sample.cores,
    sample.cpuUsedFraction,
    sample.memoryTotal,
    sample.memoryAvailable,
    options.now,
    cpuPercent,
    memoryPercent,
    reserve,
    ...sample.diskAvailable,
    ...sample.cgroups.flatMap((row) => [row.cpuCapacity, row.memoryAvailable, row.pressureSome, row.pressureFull]),
  ];
  if (
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    sample.cpuWindowMs < 60000 ||
    sample.cpuWindowMs > 120000 ||
    options.now < sample.at ||
    options.now - sample.at > 120000 ||
    sample.cores < 1 ||
    sample.memoryTotal === 0 ||
    sample.memoryAvailable > sample.memoryTotal ||
    sample.cpuUsedFraction > 1 ||
    cpuPercent < 1 ||
    cpuPercent > 100 ||
    memoryPercent < 1 ||
    memoryPercent > 100
  )
    return 'sample_invalid';
  if (BUILD_BUDGET.cpu > sample.cores || (cpuPercent / 100 - sample.cpuUsedFraction) * sample.cores < BUILD_BUDGET.cpu)
    return 'cpu_limit';
  if (
    sample.memoryAvailable - sample.memoryTotal * (1 - memoryPercent / 100) - 128 * 1024 ** 2 <
    BUILD_BUDGET.memoryBytes
  )
    return 'memory_limit';
  if (
    sample.cgroups.some(
      (row) =>
        row.memoryAvailable < BUILD_BUDGET.memoryBytes ||
        row.cpuCapacity < BUILD_BUDGET.cpu ||
        row.pressureSome >= 10 ||
        row.pressureFull >= 1,
    )
  )
    return 'cgroup_headroom';
  if (sample.diskAvailable.some((value) => value - reserve < BUILD_BUDGET.diskBytes)) return 'disk_reserve';
  return null;
}

export function requireDispatch(value) {
  if (
    value.repository !== 'opensamguk/opensamguk' ||
    value.event !== 'workflow_dispatch' ||
    !/^[a-f0-9]{40}$/.test(value.expectedSha ?? '') ||
    value.expectedSha !== value.dispatchSha ||
    value.expectedSha !== value.head
  )
    throw new Error('LOAD_DISPATCH_SOURCE_INVALID');
}

export function assertBootstrapScope(value) {
  if (
    !/^[a-f0-9]{32}$/.test(value.runId) ||
    !value.runnerWorkerAncestor ||
    value.uid <= 0 ||
    value.cgroupText.trim() !== `0::/system.slice/opensamguk-load-install-${value.runId}.scope` ||
    value.cpuMax.trim() !== '100000 100000' ||
    value.memoryMax.trim() !== '2147483648' ||
    value.swapMax.trim() !== '0'
  )
    throw new Error('LOAD_INSTALL_SCOPE_UNVERIFIED');
}

async function workerAncestor() {
  let pid = process.ppid;
  const visited = new Set();
  for (let depth = 0; pid > 1 && depth < 32 && !visited.has(pid); depth++) {
    visited.add(pid);
    const [stat, executable] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readlink(`/proc/${pid}/exe`)]);
    if (/\/bin\/Runner\.Worker$/.test(executable)) return true;
    const parent = /^\d+ \(.+\) \S (\d+) /.exec(stat)?.[1];
    if (!parent) return false;
    pid = Number(parent);
  }
  return false;
}

async function requirePlatform() {
  if (
    process.platform !== 'linux' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.RUNNER_OS !== 'Linux' ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '')
  )
    throw new Error('LOAD_BOOTSTRAP_PLATFORM_UNVERIFIED');
  const release = await readFile('/etc/os-release', 'utf8');
  if (!/^ID=ubuntu$/m.test(release) || !/^VERSION_ID="?24\.04"?$/m.test(release) || !(await workerAncestor()))
    throw new Error('LOAD_BOOTSTRAP_PLATFORM_UNVERIFIED');
}

const counter = (text) => {
  const row = /^cpu\s+(.+)$/m.exec(text)?.[1]?.trim().split(/\s+/).slice(0, 8).map(Number);
  if (!row || row.length !== 8 || row.some((n) => !Number.isSafeInteger(n) || n < 0))
    throw new Error('LOAD_BOOTSTRAP_SAMPLE_INVALID');
  return { total: row.reduce((a, b) => a + b, 0), idle: row[3] + row[4] };
};
const natural = (text) => {
  if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(Number(text.trim())))
    throw new Error('LOAD_BOOTSTRAP_SAMPLE_INVALID');
  return Number(text.trim());
};
const groupPath = (text) => {
  const path = /^0::(\/[^\r\n]*)$/m.exec(text)?.[1];
  if (!path || path.split('/').includes('..')) throw new Error('LOAD_BOOTSTRAP_SAMPLE_INVALID');
  return posix.resolve('/sys/fs/cgroup', `.${path}`);
};
async function groupSample(path, host) {
  const rows = [];
  let cursor = path;
  while (cursor !== '/sys/fs/cgroup') {
    if (!cursor.startsWith('/sys/fs/cgroup/')) throw new Error('LOAD_BOOTSTRAP_SAMPLE_INVALID');
    const [max, current, cpu, pressure] = await Promise.all(
      ['memory.max', 'memory.current', 'cpu.max', 'memory.pressure'].map((file) =>
        readFile(`${cursor}/${file}`, 'utf8'),
      ),
    );
    const parts = cpu.trim().split(/\s+/),
      period = natural(parts[1] ?? '');
    if (parts.length !== 2 || !period) throw new Error('LOAD_BOOTSTRAP_SAMPLE_INVALID');
    rows.push({
      path: cursor,
      memoryAvailable: max.trim() === 'max' ? host.memoryAvailable : Math.max(0, natural(max) - natural(current)),
      cpuCapacity: parts[0] === 'max' ? host.cores : natural(parts[0]) / period,
      pressure,
    });
    cursor = posix.dirname(cursor);
  }
  rows.push({
    path: cursor,
    ...host,
    cpuCapacity: host.cores,
    pressure: await readFile('/proc/pressure/memory', 'utf8'),
  });
  const pressureValue = (text, kind) => {
    const match = new RegExp(`^${kind} avg10=([0-9]+(?:\\.[0-9]+)?) `, 'm').exec(text)?.[1];
    if (match === undefined || !Number.isFinite(Number(match))) throw new Error('LOAD_BOOTSTRAP_SAMPLE_INVALID');
    return Number(match);
  };
  const ancestors = rows.map((row) => ({
    path: row.path,
    memoryAvailable: row.memoryAvailable,
    cpuCapacity: row.cpuCapacity,
    pressureSome: pressureValue(row.pressure, 'some'),
    pressureFull: pressureValue(row.pressure, 'full'),
  }));
  return {
    ancestors,
    sample: {
      memoryAvailable: Math.min(...ancestors.map((row) => row.memoryAvailable)),
      cpuCapacity: Math.min(...ancestors.map((row) => row.cpuCapacity)),
      pressureSome: Math.max(...ancestors.map((row) => row.pressureSome)),
      pressureFull: Math.max(...ancestors.map((row) => row.pressureFull)),
    },
  };
}

// 설치 전의 작은 네이티브 경계. 원문 stderr/명령 인자는 기록하지 않는다.
function nativeRecorder(root, receipts, pending) {
  return async (command, args, label, signal, timeoutMs, env = process.env) => {
    signal.throwIfAborted();
    const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const receipt = {
      label,
      actualClose: false,
      stdoutEnded: false,
      stderrEnded: false,
      exitCode: null,
      failed: false,
    };
    receipts.push(receipt);
    let output = '',
      length = 0,
      interrupted = false;
    const closed = new Promise((done) =>
      child.once('close', (code) => {
        receipt.actualClose = true;
        receipt.exitCode = code;
        pending.delete(closed);
        done();
      }),
    );
    pending.add(closed);
    child.on('error', () => {
      receipt.failed = true;
    });
    child.stdout.on('data', (bytes) => {
      length += bytes.length;
      if (length > 4 * 1024 * 1024) {
        receipt.failed = true;
        interrupt();
      } else output += bytes.toString('utf8');
    });
    child.stdout.on('end', () => {
      receipt.stdoutEnded = true;
    });
    let diagnosticBuffer = '',
      discardDiagnosticLine = false;
    child.stderr.on('data', (bytes) => {
      if (label !== 'scoped-dependencies') return;
      const pieces = bytes.toString('utf8').split('\n');
      for (let index = 0; index < pieces.length; index++) {
        if (!discardDiagnosticLine) {
          diagnosticBuffer += pieces[index];
          if (diagnosticBuffer.length > 4096) {
            diagnosticBuffer = '';
            discardDiagnosticLine = true;
          }
        }
        if (index < pieces.length - 1) {
          const diagnostic = !discardDiagnosticLine && parseBootstrapDiagnostic(diagnosticBuffer);
          if (diagnostic && !receipt.innerDiagnostic) receipt.innerDiagnostic = diagnostic;
          diagnosticBuffer = '';
          discardDiagnosticLine = false;
        }
      }
    });
    child.stderr.on('end', () => {
      receipt.stderrEnded = true;
    });
    child.stdout.on('error', () => {
      receipt.failed = true;
    });
    child.stderr.on('error', () => {
      receipt.failed = true;
    });
    let killTimer;
    const kill = (signal) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        receipt.failed = true;
      }
    };
    const interrupt = () => {
      if (interrupted || receipt.actualClose) return;
      interrupted = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!receipt.actualClose) kill('SIGKILL');
      }, 2000);
    };
    signal.addEventListener('abort', interrupt, { once: true });
    const timer = setTimeout(interrupt, timeoutMs);
    let guard;
    try {
      if (signal.aborted) interrupt();
      const settled = await Promise.race([
        closed.then(() => true),
        new Promise((done) => {
          guard = setTimeout(() => done(false), timeoutMs + 5000);
        }),
      ]);
      if (
        !settled ||
        interrupted ||
        !receipt.actualClose ||
        !receipt.stdoutEnded ||
        !receipt.stderrEnded ||
        receipt.exitCode !== 0 ||
        receipt.failed
      )
        throw new Error('LOAD_BOOTSTRAP_NATIVE_UNCONFIRMED');
      return output;
    } finally {
      clearTimeout(timer);
      clearTimeout(guard);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', interrupt);
    }
  };
}

export async function bootstrapSnapshot(root, native, signal) {
  return snapshotSource(root, (args) => native('git', args, 'source-git', signal, 10000), signal);
}

async function sample(dockerRoot, output, signal, phase) {
  const started = Date.now(),
    before = counter(await readFile('/proc/stat', 'utf8'));
  await delay(60000, undefined, { signal });
  phase('admission-counters');
  const [cpu, memory, cgroup, info, disk, report] = await Promise.all([
    readFile('/proc/stat', 'utf8'),
    readFile('/proc/meminfo', 'utf8'),
    readFile('/proc/self/cgroup', 'utf8'),
    readFile('/proc/cpuinfo', 'utf8'),
    statfs(dockerRoot),
    statfs(output),
  ]);
  signal.throwIfAborted();
  const after = counter(cpu),
    delta = after.total - before.total,
    idle = after.idle - before.idle;
  if (delta <= 0 || idle < 0 || idle > delta) throw new Error('LOAD_BOOTSTRAP_SAMPLE_INVALID');
  phase('admission-parse');
  const memoryValue = (name) => {
    const raw = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(memory)?.[1];
    if (raw === undefined) throw new Error('LOAD_BOOTSTRAP_SAMPLE_INVALID');
    return natural(raw) * 1024;
  };
  const host = { memoryAvailable: memoryValue('MemAvailable'), cores: info.match(/^processor\s*:/gm)?.length ?? 0 };
  phase('admission-cgroups');
  const groups = await Promise.all([
    groupSample(groupPath(cgroup), host),
    groupSample(BOOTSTRAP_DOCKER.cgroupPath, host),
  ]);
  return {
    at: Date.now(),
    cpuWindowMs: Date.now() - started,
    cores: host.cores,
    cpuUsedFraction: (delta - idle) / delta,
    memoryTotal: memoryValue('MemTotal'),
    memoryAvailable: host.memoryAvailable,
    cgroups: groups.map((row) => row.sample),
    diskAvailable: [disk.bavail * disk.bsize, report.bavail * report.bsize],
    ancestors: groups.map((row) => row.ancestors),
  };
}

async function main() {
  if (process.platform !== 'linux') {
    process.stdout.write('platform_unverified\n');
    process.exitCode = 75;
    return;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const receipts = [],
    pending = new Set(),
    native = nativeRecorder(root, receipts, pending);
  const controller = new AbortController(),
    signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), BOOTSTRAP_LIMIT_MS - 30000);
  const hard = setTimeout(() => {
    process.stderr.write('LOAD_BOOTSTRAP_UNSETTLED\n');
    process.exit(1);
  }, BOOTSTRAP_LIMIT_MS);
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let attempted = false,
    scope = '',
    output,
    failure = false,
    scopeClosed = false,
    phase = 'platform',
    failureDiagnostic,
    admissionReason;
  const cleanupFailures = [];
  try {
    await requirePlatform();
    if (process.cwd() !== root) throw new Error('LOAD_BOOTSTRAP_SOURCE_INVALID');
    if (process.argv[2] === 'inner-install') {
      phase = 'install-scope';
      const runId = process.argv[3] ?? '',
        path = groupPath(await readFile('/proc/self/cgroup', 'utf8'));
      const [cpuMax, memoryMax, swapMax] = await Promise.all(
        ['cpu.max', 'memory.max', 'memory.swap.max'].map((name) => readFile(`${path}/${name}`, 'utf8')),
      );
      assertBootstrapScope({
        runId,
        uid: process.getuid(),
        runnerWorkerAncestor: await workerAncestor(),
        cgroupText: await readFile('/proc/self/cgroup', 'utf8'),
        cpuMax,
        memoryMax,
        swapMax,
      });
      phase = 'install';
      const version = (await native('pnpm', ['--version'], 'pnpm-version', signal, 10000)).trim();
      if (version !== '10.33.0') throw new Error('LOAD_INSTALL_TOOL_UNVERIFIED');
      await native(
        'pnpm',
        ['install', '--frozen-lockfile', '--ignore-scripts'],
        'scoped-install',
        signal,
        BOOTSTRAP_LIMIT_MS - 40000,
      );
      await writeFile(
        resolve(root, '.load-reports', `bootstrap-${runId}`, 'scope.json'),
        JSON.stringify({
          verified: true,
          uid: process.getuid(),
          cpuMax: cpuMax.trim(),
          memoryMax: memoryMax.trim(),
          swapMax: swapMax.trim(),
          ancestorVerified: true,
          receipts,
          pending: pending.size,
        }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      return;
    }
    if (process.argv.length !== 2 || process.getuid() === 0 || process.version !== 'v24.22.0')
      throw new Error('LOAD_BOOTSTRAP_OPTIONS_INVALID');
    phase = 'source';
    const before = await bootstrapSnapshot(root, native, signal);
    requireDispatch({
      repository: process.env.GITHUB_REPOSITORY,
      event: process.env.GITHUB_EVENT_NAME,
      expectedSha: process.env.LOAD_EXPECTED_SHA,
      dispatchSha: process.env.GITHUB_SHA,
      head: before.head,
    });
    phase = 'docker';
    if (process.env.DOCKER_HOST !== undefined || process.env.DOCKER_CONTEXT !== undefined)
      throw new Error('LOAD_LOCAL_DOCKER_REQUIRED');
    let endpoint;
    try {
      const context = (await native('docker', ['context', 'show'], 'context-selection', signal, 10000)).trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(context)) throw new Error();
      endpoint = JSON.parse(
        await native(
          'docker',
          ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'],
          'context-endpoint',
          signal,
          10000,
        ),
      );
      if (
        endpoint !== BOOTSTRAP_DOCKER.endpoint ||
        (await realpath(BOOTSTRAP_DOCKER.cgroupPath)) !== BOOTSTRAP_DOCKER.cgroupPath
      )
        throw new Error();
    } catch {
      throw new Error('LOAD_LOCAL_DOCKER_REQUIRED');
    }
    const info = JSON.parse(
      await native(
        'docker',
        [
          '--host',
          endpoint,
          'info',
          '--format',
          '{"root":{{json .DockerRootDir}},"driver":{{json .CgroupDriver}},"version":{{json .CgroupVersion}},"os":{{json .OSType}}}',
        ],
        'docker-information',
        signal,
        10000,
      ),
    );
    if (
      info.os !== 'linux' ||
      info.driver !== 'systemd' ||
      info.version !== '2' ||
      typeof info.root !== 'string' ||
      !info.root.startsWith('/')
    )
      throw new Error('LOAD_BOOTSTRAP_DAEMON_UNVERIFIED');
    const runId = randomUUID().replaceAll('-', '');
    output = resolve(root, '.load-reports', `bootstrap-${runId}`);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await mkdir(output, { recursive: false, mode: 0o700 });
    phase = 'admission-window';
    const admission = await sample(info.root, output, signal, (value) => {
      phase = value;
    });
    phase = 'admission-decision';
    const reason = bootstrapReason(admission, { now: Date.now() });
    admissionReason = reason;
    await writeFile(
      resolve(output, 'admission.json'),
      JSON.stringify({ admission, reason, budget: BUILD_BUDGET, docker: BOOTSTRAP_DOCKER }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    if (reason) throw new Error('LOAD_BOOTSTRAP_ADMISSION_REFUSED');
    phase = 'install-scope';
    scope = `opensamguk-load-install-${runId}.scope`;
    if (
      (
        await native(
          'systemctl',
          ['list-units', '--all', '--no-legend', '--plain', '--no-pager', '--type=scope', scope],
          'scope-baseline',
          signal,
          10000,
        )
      ).trim()
    )
      throw new Error('LOAD_INSTALL_SCOPE_EXISTS');
    const safeEnvironment = {};
    for (const name of [
      'PATH',
      'HOME',
      'PNPM_HOME',
      'GITHUB_ACTIONS',
      'RUNNER_ENVIRONMENT',
      'RUNNER_OS',
      'GITHUB_RUN_ID',
    ])
      if (process.env[name] !== undefined) safeEnvironment[name] = process.env[name];
    safeEnvironment.HOME = resolve(output, 'home');
    await mkdir(safeEnvironment.HOME, { mode: 0o700 });
    phase = 'install';
    attempted = true;
    await native(
      'sudo',
      [
        '-n',
        `--preserve-env=${Object.keys(safeEnvironment).join(',')}`,
        'systemd-run',
        '--scope',
        '--quiet',
        `--unit=${scope}`,
        '--slice=system.slice',
        '--expand-environment=no',
        '--property=CPUQuota=100%',
        '--property=CPUQuotaPeriodSec=100ms',
        '--property=MemoryMax=2147483648',
        '--property=MemorySwapMax=0',
        '/usr/bin/setpriv',
        `--reuid=${process.getuid()}`,
        `--regid=${process.getgid()}`,
        '--init-groups',
        process.execPath,
        fileURLToPath(import.meta.url),
        'inner-install',
        runId,
      ],
      'scoped-dependencies',
      signal,
      Math.max(1, BOOTSTRAP_LIMIT_MS - 40000 - (Date.now() - admission.at + admission.cpuWindowMs)),
      safeEnvironment,
    );
    phase = 'scope-proof';
    const scopeProof = JSON.parse(await readFile(resolve(output, 'scope.json'), 'utf8'));
    if (
      scopeProof.verified !== true ||
      scopeProof.pending !== 0 ||
      !Array.isArray(scopeProof.receipts) ||
      !scopeProof.receipts.length ||
      scopeProof.receipts.some(
        (row) => !row.actualClose || !row.stdoutEnded || !row.stderrEnded || row.exitCode !== 0 || row.failed,
      )
    )
      throw new Error('LOAD_INSTALL_SCOPE_UNVERIFIED');
    phase = 'source-proof';
    const after = await bootstrapSnapshot(root, native, signal);
    if (before.head !== after.head || before.sha256 !== after.sha256) throw new Error('LOAD_BOOTSTRAP_SOURCE_CHANGED');
    phase = 'publish';
    await writeFile(resolve(output, 'source.json'), JSON.stringify(before) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(
      resolve(root, '.load-reports', 'bootstrap.json'),
      JSON.stringify({
        version: 1,
        runId,
        source: before,
        budget: BUILD_BUDGET,
        docker: BOOTSTRAP_DOCKER,
        scopeVerified: true,
      }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    failure = true;
    failureDiagnostic = bootstrapDiagnostic(phase, error, admissionReason);
  } finally {
    const cleanup = async () => {
      if (attempted) {
        const clean = new AbortController(),
          timer = setTimeout(() => clean.abort(), 20000);
        try {
          const remaining = (
            await native(
              'systemctl',
              ['list-units', '--all', '--no-legend', '--plain', '--no-pager', '--type=scope', scope],
              'scope-final-inventory',
              clean.signal,
              5000,
            )
          ).trim();
          if (remaining) {
            await native('sudo', ['-n', 'systemctl', 'stop', scope], 'stop-owned-install-scope', clean.signal, 10000);
            if (
              (
                await native(
                  'systemctl',
                  ['list-units', '--all', '--no-legend', '--plain', '--no-pager', '--type=scope', scope],
                  'scope-post-stop',
                  clean.signal,
                  5000,
                )
              ).trim()
            )
              throw new Error();
          }
          scopeClosed = true;
        } catch {
          cleanupFailures.push('INSTALL_SCOPE_UNSETTLED');
        } finally {
          clearTimeout(timer);
        }
      }
      if (output) {
        try {
          await writeFile(
            resolve(output, 'lifecycle.json'),
            JSON.stringify({
              failure,
              diagnostic: failureDiagnostic,
              scopeClosed,
              receipts,
              pending: pending.size,
              cleanupFailures,
            }) + '\n',
            { flag: 'wx', mode: 0o600 },
          );
        } catch {
          cleanupFailures.push('BOOTSTRAP_RECEIPT_FAILED');
        }
      }
    };
    await cleanup();
    clearTimeout(timer);
    clearTimeout(hard);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  if (failure || cleanupFailures.length || pending.size || (attempted && !scopeClosed)) {
    process.stderr.write(
      JSON.stringify({
        event: 'LOAD_BOOTSTRAP_DIAGNOSTIC',
        ...failureDiagnostic,
        innerDiagnostic: receipts.find((row) => row.label === 'scoped-dependencies')?.innerDiagnostic ?? null,
        scopeAttempted: attempted,
        scopeClosed,
        pending: pending.size,
        cleanupFailed: cleanupFailures.length > 0,
      }) + '\n',
    );
    throw new Error('LOAD_BOOTSTRAP_FAILED');
  }
  process.stdout.write('LOAD_BOOTSTRAP_READY\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write('LOAD_BOOTSTRAP_FAILED\n');
    process.exitCode = 1;
  });
}
