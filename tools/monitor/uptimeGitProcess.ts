import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export class UptimeGitError extends Error {
  constructor(
    readonly kind:
      'configuration' | 'command' | 'timeout' | 'output' | 'lifecycle' | 'read' | 'push' | 'state' | 'cleanup',
    readonly cleanupSafe = true,
  ) {
    super(`가동 확인 Git 작업 실패 (${kind}).`);
    this.name = 'UptimeGitError';
  }
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };
export interface GitProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  graceMs?: number;
  command?: { file: string; prefix: string[] };
  onSpawn?: (pid: number) => void;
}

async function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ value })),
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminate(child: ChildProcess, close: Promise<Exit>, graceMs: number) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // exit 뒤 close를 기다리는 PID는 이미 재사용됐을 수 있으므로 다시 겨냥하지 않는다.
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => {
        // spawn으로 소유한 PID의 트리만 종료한다. 다른 Git 프로세스는 찾지 않는다.
        execFile(
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 },
          () => resolve(),
        );
      });
  } else {
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new UptimeGitError('lifecycle', false);
      }
    };
    kill('SIGTERM');
    await within(close, graceMs);
    // 부모가 먼저 닫혀도 TERM을 무시한 보조 프로세스가 같은 그룹에 남을 수 있다.
    kill('SIGKILL');
  }
  if (!(await within(close, graceMs))) throw new UptimeGitError('lifecycle', false);
}

/** 오류에는 Git stderr·원격·인증 도우미의 출력을 싣지 않는다. */
export async function gitProcess(
  args: string[],
  options: GitProcessOptions,
): Promise<{ stdout: string; code: number }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const graceMs = options.graceMs ?? 5000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isInteger(graceMs) ||
    graceMs < 1 ||
    graceMs > 5000
  )
    throw new UptimeGitError('configuration');
  const command = options.command ?? { file: 'git', prefix: [] };
  const child = spawn(command.file, [...command.prefix, ...args], {
    cwd: options.cwd,
    env: { ...options.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let closed = false,
    spawnFailed = false,
    bytes = 0,
    output = '';
  let complete!: (exit: Exit | null) => void;
  const finished = new Promise<Exit | null>((resolve) => (complete = resolve));
  const close = new Promise<Exit>((resolve) => {
    child.once('close', (code, signal) => {
      closed = true;
      const exit = { code, signal };
      resolve(exit);
      complete(exit);
    });
  });
  child.once('error', () => {
    spawnFailed = true;
  });
  // 먼저 종료한 자식의 EPIPE도 close 결과와 함께 판정한다.
  child.stdin.on('error', () => {
    spawnFailed = true;
  });
  let reason: 'timeout' | 'output' | undefined;
  let stopping: Promise<void> | undefined,
    lifecycleFailed = false;
  const stop = (kind: 'timeout' | 'output') => {
    if (closed || stopping) return;
    reason = kind;
    stopping = terminate(child, close, graceMs).catch(() => {
      lifecycleFailed = true;
      // 종료 미확인 상태를 성공으로 바꾸지 않는다. 호출자 종료를 막는 자기 I/O만 닫는다.
      child.unref();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      complete(null);
    });
  };
  const collect = (chunk: Buffer, stdout: boolean) => {
    bytes += chunk.byteLength;
    if (bytes > 1024 * 1024) stop('output');
    else if (stdout) output += chunk.toString('utf8');
  };
  child.stdout.on('data', (chunk: Buffer) => collect(chunk, true));
  child.stderr.on('data', (chunk: Buffer) => collect(chunk, false));
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  try {
    try {
      if (child.pid) options.onSpawn?.(child.pid);
    } catch {
      stop('output');
    }
    child.stdin.end(options.input);
    const exit = await finished;
    await stopping;
    if (lifecycleFailed || exit === null) throw new UptimeGitError('lifecycle', false);
    if (reason) throw new UptimeGitError(reason);
    if (spawnFailed || exit.signal || exit.code === null) throw new UptimeGitError('command');
    return { stdout: output, code: exit.code };
  } finally {
    clearTimeout(timer);
  }
}
