import type { ChildProcess } from 'node:child_process';

const SHUTDOWN_REQUEST = 'opensamguk:shutdown';
type ShutdownSignal = 'SIGTERM' | 'SIGINT';

export function onShutdownRequest(handler: () => void): () => void {
  const onMessage = (message: unknown) => {
    if (
      message !== null &&
      typeof message === 'object' &&
      Object.getPrototypeOf(message) === Object.prototype &&
      Object.keys(message).length === 1 &&
      'type' in message &&
      message.type === SHUTDOWN_REQUEST
    ) {
      handler();
    }
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  if (process.channel) process.on('message', onMessage);
  return () => {
    process.off('SIGTERM', handler);
    process.off('SIGINT', handler);
    process.off('message', onMessage);
  };
}

export function requestShutdown(
  child: ChildProcess,
  signal: ShutdownSignal,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    child.kill(signal);
    return;
  }
  if (!child.connected || !child.send) return;
  try {
    // 전송 실패는 실제 exit가 아니다. 호출자의 5초 강제 종료를 계속 기다린다.
    child.send({ type: SHUTDOWN_REQUEST }, () => {});
  } catch {
    // 끊긴 IPC에 신호로 되돌아가면 Windows가 정리 전에 자식을 끝낸다.
  }
}

export async function stopOwnedChild(
  child: ChildProcess,
  exited: Promise<unknown>,
  signal: ShutdownSignal = 'SIGTERM',
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    requestShutdown(child, signal, platform);
    await exited;
  } finally {
    clearTimeout(force);
  }
}
