import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { snapshotSource } from './source-snapshot.mjs';

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
        throw new Error('LOAD_NATIVE_CHILD_UNSETTLED');
      }
      if (!commandSettled(receipt) || receipt.failed || receipt.exitCode !== 0 || aborted)
        throw new Error('LOAD_NATIVE_COMMAND_FAILED');
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
