import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { snapshotSource } from './source-snapshot.mjs';

const driverStages = new Set([
  'options',
  'runner-provenance',
  'local-daemon',
  'source-binding',
  'compose-contract',
  'docker-information',
  'admission',
  'runtime-images',
  'ownership-baseline',
  'project-create',
  'private-volume-init',
  'postgres-start',
  'database-identity',
  'migrations',
  'resources',
  'server-start',
  'engine-start',
  'generator-start',
  'observation',
  'generator-progress',
  'final-witness',
  'evidence-copy',
  'report',
  'cleanup',
  'lifecycle-write',
  'unknown',
]);
const driverCodes = new Set([
  'LOAD_OPTIONS_INVALID',
  'LOAD_KEEP_FORBIDDEN',
  'LOAD_SOURCE_PIN_REQUIRED',
  'LOAD_WAIT_LIMIT',
  'LOAD_LOCAL_DOCKER_REQUIRED',
  'LOAD_SOURCE_PIN_MISMATCH',
  'LOAD_COMPOSE_TMPFS_INVALID',
  'LOAD_DOCKER_ISOLATION_UNVERIFIED',
  'LOAD_IMAGE_SOURCE_INVALID',
  'LOAD_POSTGRES_IMAGE_MISSING',
  'LOAD_RUNTIME_METADATA_INVALID',
  'LOAD_CONTAINER_OWNERSHIP_INVALID',
  'LOAD_CONTAINER_LIMITS_UNVERIFIED',
  'LOAD_CONTAINER_PORT_UNVERIFIED',
  'LOAD_CONTAINER_CGROUP_UNVERIFIED',
  'LOAD_AUXILIARY_CONTAINER_REMAINS',
  'LOAD_OWNERSHIP_BASELINE_NOT_EMPTY',
  'LOAD_DATABASE_IDENTITY_INVALID',
  'LOAD_SETUP_DEADLINE_EXCEEDED',
  'LOAD_HELPER_DEADLINE_EXCEEDED',
  'LOAD_CONTAINER_NORMAL_EXIT_UNCONFIRMED',
  'LOAD_RUNTIME_RESOURCE_EXHAUSTED',
  'LOAD_RUNTIME_SAMPLE_INVALID',
  'LOAD_GENERATOR_FAILED',
  'LOAD_GENERATOR_PHASE_INVALID',
  'LOAD_OBSERVER_FAILED',
  'LOAD_DATABASE_CONNECTIONS_REMAIN',
  'LOAD_FRAGMENT_INVALID',
  'LOAD_NATIVE_COMMAND_FAILED',
  'LOAD_NATIVE_CHILD_UNSETTLED',
  'LOAD_CLEANUP_UNCONFIRMED',
  'LOAD_EXECUTION_FAILED',
  'ADMISSION_REFUSED',
  'SCHEMA_INVALID',
  'RESOURCE_MISSING',
  'RESOURCE_DENIED',
  'UNCLASSIFIED',
]);
const nativeLabels = new Set([
  'source-git',
  'docker-context-selection',
  'docker-context-endpoint',
  'docker-information',
  'image-source',
  'postgres-image',
  'project-baseline',
  'volume-baseline',
  'volume-names',
  'network-names',
  'create-project',
  'owned-container-ids',
  'owned-container-proof',
  'postgres-start',
  'database-identity',
  'server-start',
  'engine-supervisor-start',
  'generator-start',
  'owned-database-proof',
  'runtime-stats',
  'generator-phase',
  'release-generator',
  'generator-actual-exit',
  'stop-application',
  'copy-owned-evidence',
  'cleanup-stop-application',
  'cleanup-stop-project',
  'copy-partial-evidence',
  'delete-owned-project',
  'post-delete-volume-catalog',
  ...['initialize-private-volumes', 'migrations', 'resources', 'final-database-witness'].flatMap((label) =>
    ['idle-start', 'parent-proof', 'execute', 'stop', 'exit-proof', 'remove'].map((suffix) => `${label}-${suffix}`),
  ),
]);
export type DriverDiagnostic = {
  event: 'LOAD_DRIVER_DIAGNOSTIC';
  version: 1;
  stage: string;
  code: string;
  nativeLabel: string | null;
  exitClass: 'zero' | 'nonzero' | 'unconfirmed';
  exitCode: number | null;
  closeStatus: 'actual-close' | 'unconfirmed';
  stdoutEnded: boolean;
  stderrEnded: boolean;
  aborted: boolean;
};
const nativeFailures = new WeakMap<
  Error,
  Pick<
    DriverDiagnostic,
    'nativeLabel' | 'exitClass' | 'exitCode' | 'closeStatus' | 'stdoutEnded' | 'stderrEnded' | 'aborted'
  >
>();
export function driverFailureDiagnostic(stage: string, error: unknown): DriverDiagnostic {
  const own = (key: string) =>
    error instanceof Error ? Object.getOwnPropertyDescriptor(error, key)?.value : undefined;
  const message: unknown = own('message'),
    code: unknown = own('code');
  const fixedCode =
    typeof message === 'string' && driverCodes.has(message)
      ? message
      : own('name') === 'ZodError'
        ? 'SCHEMA_INVALID'
        : code === 'ENOENT'
          ? 'RESOURCE_MISSING'
          : code === 'EACCES' || code === 'EPERM'
            ? 'RESOURCE_DENIED'
            : 'UNCLASSIFIED';
  return {
    event: 'LOAD_DRIVER_DIAGNOSTIC',
    version: 1,
    stage: driverStages.has(stage) ? stage : 'unknown',
    code: fixedCode,
    nativeLabel: null,
    exitClass: 'unconfirmed',
    exitCode: null,
    closeStatus: 'unconfirmed',
    stdoutEnded: false,
    stderrEnded: false,
    aborted: false,
    ...(error instanceof Error ? nativeFailures.get(error) : undefined),
  };
}
export function parseDriverDiagnostic(value: unknown): DriverDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = [
      'event',
      'version',
      'stage',
      'code',
      'nativeLabel',
      'exitClass',
      'exitCode',
      'closeStatus',
      'stdoutEnded',
      'stderrEnded',
      'aborted',
    ];
  if (
    Object.keys(descriptors).length !== keys.length ||
    keys.some((key) => !descriptors[key] || !('value' in descriptors[key]!))
  )
    return;
  const row = Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
  if (
    row.event !== 'LOAD_DRIVER_DIAGNOSTIC' ||
    row.version !== 1 ||
    !driverStages.has(row.stage) ||
    !driverCodes.has(row.code) ||
    !(row.nativeLabel === null || nativeLabels.has(row.nativeLabel)) ||
    !['zero', 'nonzero', 'unconfirmed'].includes(row.exitClass) ||
    !(row.exitCode === null || (Number.isInteger(row.exitCode) && row.exitCode >= 0 && row.exitCode <= 255)) ||
    !['actual-close', 'unconfirmed'].includes(row.closeStatus) ||
    ['stdoutEnded', 'stderrEnded', 'aborted'].some((key) => typeof row[key] !== 'boolean')
  )
    return;
  if (row.exitClass !== (row.exitCode === null ? 'unconfirmed' : row.exitCode === 0 ? 'zero' : 'nonzero')) return;
  return row as DriverDiagnostic;
}
export function captureDriverDiagnostics() {
  const records: DriverDiagnostic[] = [];
  let line: number[] = [],
    oversized = false;
  return {
    records,
    feed(bytes: Buffer) {
      for (const byte of bytes) {
        if (records.length === 8) return;
        if (byte === 10) {
          if (!oversized) {
            try {
              const value = parseDriverDiagnostic(JSON.parse(Buffer.from(line).toString('utf8')));
              if (value) records.push(value);
            } catch {
              /* Raw stderr is discarded. */
            }
          }
          line = [];
          oversized = false;
        } else if (!oversized) {
          if (line.length === 2048) {
            line = [];
            oversized = true;
          } else line.push(byte);
        }
      }
    },
  };
}

export type CommandReceipt = {
  label: string;
  pid: number | null;
  startedAt: number;
  closedAt: number | null;
  stdoutEnded: boolean;
  stderrEnded: boolean;
  actualClose: boolean;
  exitCode: number | null;
  signal: string | null;
  failed: boolean;
  driverDiagnostics?: DriverDiagnostic[];
};
export function commandSettled(receipt: CommandReceipt): boolean {
  return receipt.actualClose && receipt.closedAt !== null && receipt.stdoutEnded && receipt.stderrEnded;
}
export function mayDeleteOwnedData(input: {
  succeeded: boolean;
  ownershipMatches: boolean;
  databaseOidMatches: boolean;
  databaseConnections: number | null;
  commands: readonly CommandReceipt[];
  pending: number;
  stickyUnsettled: boolean;
}): boolean {
  return (
    input.succeeded &&
    input.ownershipMatches &&
    input.databaseOidMatches &&
    input.databaseConnections === 0 &&
    input.commands.length > 0 &&
    input.commands.every((row) => commandSettled(row) && !row.failed && row.exitCode === 0) &&
    input.pending === 0 &&
    !input.stickyUnsettled
  );
}

export class OwnedCommands {
  readonly receipts: CommandReceipt[] = [];
  readonly pending = new Set<Promise<void>>();
  stickyUnsettled = false;
  constructor(readonly cwd: string) {}

  async run(
    command: string,
    args: readonly string[],
    options: {
      label: string;
      signal: AbortSignal;
      timeoutMs: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<string> {
    options.signal.throwIfAborted();
    if (!/^[a-z0-9-]+$/.test(options.label) || options.timeoutMs <= 0 || !Number.isFinite(options.timeoutMs))
      throw new Error('LOAD_COMMAND_OPTIONS_INVALID');
    const child = spawn(command, [...args], {
      cwd: this.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Linux에서는 이 네이티브 명령과 그 compose plugin만의 프로세스 그룹을 소유한다.
      // unref하지 않고 실제 close/두 EOF까지 기다리므로 PID 부재로 완료를 대신하지 않는다.
      detached: process.platform === 'linux',
    });
    const receipt: CommandReceipt = {
      label: options.label,
      pid: child.pid ?? null,
      startedAt: Date.now(),
      closedAt: null,
      stdoutEnded: false,
      stderrEnded: false,
      actualClose: false,
      exitCode: null,
      signal: null,
      failed: false,
    };
    this.receipts.push(receipt);
    const diagnostics = options.label === 'actual-load-driver' ? captureDriverDiagnostics() : undefined;
    if (diagnostics) receipt.driverDiagnostics = diagnostics.records;
    let output = '',
      size = 0,
      aborted = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((done) => {
      resolveClosed = done;
    });
    this.pending.add(closed);
    child.stdout.on('data', (bytes: Buffer) => {
      size += bytes.length;
      if (size > 4 * 1024 * 1024) {
        receipt.failed = true;
        stop();
      } else output += bytes.toString('utf8');
    });
    // 네이티브 오류/컨테이너 로그에 연결 문자열이 포함될 수 있으므로 stderr 원문을 저장하지 않는다.
    child.stderr.resume();
    if (diagnostics) child.stderr.on('data', (bytes: Buffer) => diagnostics.feed(bytes));
    child.stdout.on('end', () => {
      receipt.stdoutEnded = true;
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
    child.on('error', () => {
      receipt.failed = true;
    });
    child.once('close', (code, signal) => {
      receipt.actualClose = true;
      receipt.closedAt = Date.now();
      receipt.exitCode = code;
      receipt.signal = signal;
      this.pending.delete(closed);
      resolveClosed();
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined, abortGuard: ReturnType<typeof setTimeout> | undefined;
    let resolveAborted!: (value: false) => void;
    const abortedSettlement = new Promise<false>((done) => {
      resolveAborted = done;
    });
    function terminate(signal: NodeJS.Signals) {
      try {
        if (process.platform === 'linux' && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        receipt.failed = true;
      }
    }
    function stop() {
      if (aborted || receipt.actualClose) return;
      aborted = true;
      terminate('SIGTERM');
      killTimer = setTimeout(() => {
        if (!receipt.actualClose) terminate('SIGKILL');
      }, 5_000);
      abortGuard = setTimeout(() => resolveAborted(false), 10_000);
    }
    options.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, options.timeoutMs);
    if (options.signal.aborted) stop();
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        closed.then(() => true),
        abortedSettlement,
        new Promise<false>((done) => {
          guard = setTimeout(() => done(false), options.timeoutMs + 10_000);
        }),
      ]);
      if (!settled) {
        this.stickyUnsettled = true;
        throw nativeFailure('LOAD_NATIVE_CHILD_UNSETTLED', receipt, aborted);
      }
      if (!commandSettled(receipt) || receipt.failed || receipt.exitCode !== 0 || aborted)
        throw nativeFailure('LOAD_NATIVE_COMMAND_FAILED', receipt, aborted);
      return output;
    } finally {
      clearTimeout(timer);
      if (guard) clearTimeout(guard);
      if (killTimer) clearTimeout(killTimer);
      if (abortGuard) clearTimeout(abortGuard);
      options.signal.removeEventListener('abort', stop);
    }
  }
}

function nativeFailure(code: string, receipt: CommandReceipt, aborted: boolean): Error {
  const error = new Error(code),
    exitCode =
      Number.isInteger(receipt.exitCode) && receipt.exitCode! >= 0 && receipt.exitCode! <= 255
        ? receipt.exitCode
        : null;
  nativeFailures.set(error, {
    nativeLabel: nativeLabels.has(receipt.label) ? receipt.label : null,
    exitClass: exitCode === null ? 'unconfirmed' : exitCode === 0 ? 'zero' : 'nonzero',
    exitCode,
    closeStatus: receipt.actualClose ? 'actual-close' : 'unconfirmed',
    stdoutEnded: receipt.stdoutEnded,
    stderrEnded: receipt.stderrEnded,
    aborted,
  });
  return error;
}

export async function sourceSnapshot(commands: OwnedCommands, signal: AbortSignal) {
  return snapshotSource(
    commands.cwd,
    (args) => commands.run('git', args, { label: 'source-git', signal, timeoutMs: 10_000 }),
    signal,
  );
}

export async function writeEvidence(path: string, value: unknown): Promise<void> {
  // 호출자가 소유하는 새 경로만 받으며 기존 JSON 원본은 덮어쓰지 않는다.
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
