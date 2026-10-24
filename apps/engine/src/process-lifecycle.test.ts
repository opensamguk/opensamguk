import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { requestShutdown, stopOwnedChild } from './process-lifecycle';

type Event = { event: string; initial?: number[]; remaining?: number[] };
const owned: ChildProcess[] = [];

function alive(child: ChildProcess) {
  try {
    process.kill(child.pid!, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('프로세스 응답을 받지 못했습니다.');
    await delay(10);
  }
}

async function fixture(mode = 'cooperate', ipc = true) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/test/shutdownFixture.ts', mode], {
    cwd: new URL('../../../', import.meta.url),
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  owned.push(child);
  const exited = once(child, 'exit');
  const closed = once(child, 'close');
  const errors: Error[] = [];
  child.on('error', (error) => errors.push(error));
  const events: Event[] = [];
  let output = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    const lines = output.split('\n');
    output = lines.pop()!;
    for (const line of lines) events.push(JSON.parse(line) as Event);
  });
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  await until(() => events.some(({ event }) => event === 'ready'));
  return { child, exited, closed, errors, events, stderr: () => stderr };
}

afterEach(async () => {
  await Promise.all(
    owned.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }),
  );
});

describe('실제 소유 프로세스 종료', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s 요청은 정리와 처리기 해제 뒤 코드 0으로 끝난다', async (signal) => {
    const running = await fixture();
    await stopOwnedChild(running.child, running.exited, signal);
    await running.closed;
    expect(running.child.exitCode).toBe(0);
    expect(running.child.signalCode).toBeNull();
    const cleaned = running.events.filter(({ event }) => event === 'cleaned');
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]!.remaining).toEqual(cleaned[0]!.initial);
    expect(running.errors).toEqual([]);
    expect(running.stderr()).toBe('');
  });

  it('win32 요청 경로는 모든 OS에서 IPC로 정리를 요청한다', async () => {
    const running = await fixture();
    await stopOwnedChild(running.child, running.exited, 'SIGTERM', 'win32');
    await running.closed;
    expect(running.child.exitCode).toBe(0);
    expect(running.events.map(({ event }) => event)).toEqual(['ready', 'received', 'cleaned']);
    const cleaned = running.events[2]!;
    expect(cleaned.remaining).toEqual(cleaned.initial);
    expect(running.errors).toEqual([]);
  });

  it('알 수 없는 메시지는 무시하고 뒤의 유효한 종료 요청을 받는다', async () => {
    const running = await fixture();
    const messages = ['shutdown', null, [], { type: 'other' }, { type: 'opensamguk:shutdown', extra: true }];
    for (let i = 0; i < messages.length; i++) {
      running.child.send!(messages[i]!);
      await until(() => running.events.filter(({ event }) => event === 'received').length === i + 1);
      expect(alive(running.child)).toBe(true);
      expect(running.events.some(({ event }) => event === 'cleaned')).toBe(false);
    }
    await stopOwnedChild(running.child, running.exited, 'SIGTERM', 'win32');
    await running.closed;
    expect(running.child.exitCode).toBe(0);
    expect(running.events.filter(({ event }) => event === 'cleaned')).toHaveLength(1);
    expect(running.errors).toEqual([]);
  });

  it('무시되거나 전달되지 않은 요청은 5초 뒤 자기 자식만 강제 종료한다', async () => {
    const unrelated = await fixture('ignore');
    for (const ipc of [true, false]) {
      const running = await fixture('ignore', ipc);
      const started = performance.now();
      await stopOwnedChild(running.child, running.exited, 'SIGTERM', 'win32');
      await running.closed;
      expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
      expect(running.child.exitCode).toBeNull();
      expect(running.child.signalCode).toBe('SIGKILL');
      expect(running.events.filter(({ event }) => event === 'ignored')).toHaveLength(ipc ? 1 : 0);
      expect(running.errors).toEqual([]);
      expect(alive(unrelated.child)).toBe(true);
    }
  }, 15_000);

  it('끊긴 IPC의 요청은 종료나 전송 오류로 바꾸지 않는다', async () => {
    const running = await fixture('ignore');
    const disconnected = once(running.child, 'disconnect');
    running.child.disconnect();
    await disconnected;
    requestShutdown(running.child, 'SIGTERM', 'win32');
    await delay(25);
    expect(alive(running.child)).toBe(true);
    expect(running.child.exitCode).toBeNull();
    expect(running.child.signalCode).toBeNull();
    expect(running.errors).toEqual([]);
  });
});
