import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function cardProcessProbe(
  worldId: string,
  mode: 'BEFORE_COMMIT' | 'AFTER_COMMIT' | 'RECOVER',
  boundary?: { type: 'MONTHLY' | 'BATTLE'; tick: number },
) {
  const require = createRequire(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(require.resolve('tsx')).href,
      fileURLToPath(new URL('./stratagem-cards-crash-worker.ts', import.meta.url)),
    ],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: {
        ...process.env,
        CARDS_CRASH_WORLD: worldId,
        CARDS_CRASH_MODE: mode,
        CARDS_CRASH_BOUNDARY: boundary?.type ?? 'INPUT',
        CARDS_CRASH_TICK: boundary ? String(boundary.tick) : '',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    },
  );
  let stderr = '',
    timeout: ReturnType<typeof setTimeout>;
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-1500);
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once('close', resolve);
    child.once('error', () => resolve(null));
  });
  const ready = new Promise<number>((resolve, reject) => {
    timeout = setTimeout(() => reject(Error(`계략 패 프로세스 신호가 없습니다: ${stderr}`)), 15000);
    child.once('error', reject);
    child.once('exit', () => reject(Error(`계략 패 신호 전 프로세스 종료: ${stderr}`)));
    child.once('message', (message) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'phase' in message &&
        message.phase === mode &&
        'pid' in message &&
        message.pid === child.pid
      )
        resolve(child.pid!);
      else reject(Error('계략 패 중단 시험 신호가 다릅니다.'));
    });
  });
  try {
    const pid = await ready;
    if (mode !== 'RECOVER') {
      if (!child.kill('SIGKILL')) throw Error('계략 패 시험 프로세스를 강제 종료하지 못했습니다.');
      await closed;
    } else if ((await closed) !== 0) throw Error(`계략 패 재시작 프로세스 실패: ${stderr}`);
    return pid;
  } finally {
    clearTimeout(timeout!);
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    await closed;
  }
}
