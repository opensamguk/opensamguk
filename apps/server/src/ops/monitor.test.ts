import { createDb } from '@opensamguk/db';
import fastify from 'fastify';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_POLL_MS,
  CAPACITY_READ_MS,
  CAPACITY_REPEAT_MS,
  CapacityMonitorConfig,
  type DiskSpace,
} from './capacity';
import { createCapacityMonitor, registerCapacityMonitor, type CapacityMonitorDependencies } from './monitor';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/capacity_fixture';
const paths = [resolve('private-data-path-canary'), resolve('private-backup-path-canary')];
const config = new CapacityMonitorConfig(paths, 1000n, WEBHOOK);
const healthy: DiskSpace = { blocks: 100n, bsize: 1n, bfree: 30n, bavail: 30n };
const warning: DiskSpace = { ...healthy, bfree: 20n, bavail: 20n };
const critical: DiskSpace = { ...healthy, bfree: 10n, bavail: 10n };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const state = { now: 0, disk: healthy, bytes: 0n, delivered: true };
  const dependencies = {
    readDisk: vi.fn<CapacityMonitorDependencies['readDisk']>(async () => state.disk),
    readDatabase: vi.fn(async () => state.bytes),
    notify: vi.fn<CapacityMonitorDependencies['notify']>(async () => state.delivered),
    failure: vi.fn(),
    now: () => state.now,
  } satisfies CapacityMonitorDependencies;
  const monitor = createCapacityMonitor(config, dependencies);
  return { state, dependencies, monitor };
}
afterEach(() => vi.useRealTimers());

describe('independent capacity observations and notification state', () => {
  it('reads only exact configured paths and current database source once per poll', async () => {
    const f = fixture();
    await f.monitor.poll();
    expect(f.dependencies.readDisk.mock.calls.map((call) => call[0])).toEqual(paths);
    expect(f.dependencies.readDatabase).toHaveBeenCalledTimes(1);
    expect(f.dependencies.notify).not.toHaveBeenCalled();
    await f.monitor.stop();
  });
  it('suppresses identical warnings until exactly 30 minutes and recovers once', async () => {
    const f = fixture();
    f.state.disk = warning;
    await f.monitor.poll();
    expect(f.dependencies.notify).toHaveBeenCalledTimes(2);
    f.state.now = CAPACITY_REPEAT_MS - 1;
    await f.monitor.poll();
    expect(f.dependencies.notify).toHaveBeenCalledTimes(2);
    f.state.now++;
    await f.monitor.poll();
    expect(f.dependencies.notify).toHaveBeenCalledTimes(4);
    f.state.disk = healthy;
    await f.monitor.poll();
    await f.monitor.poll();
    expect(f.dependencies.notify).toHaveBeenCalledTimes(6);
    expect(f.dependencies.notify.mock.calls.slice(-2).every((call) => call[1].includes('회복'))).toBe(true);
    await f.monitor.stop();
  });
  it('notifies severity escalation immediately and starts fresh memory after restart', async () => {
    const f = fixture();
    f.state.disk = warning;
    await f.monitor.poll();
    f.state.disk = critical;
    await f.monitor.poll();
    expect(f.dependencies.notify).toHaveBeenCalledTimes(4);
    await f.monitor.stop();
    const restarted = createCapacityMonitor(config, f.dependencies);
    await restarted.poll();
    expect(f.dependencies.notify).toHaveBeenCalledTimes(6);
    await restarted.stop();
  });
  it('keeps failed notifications observable, rate limits attempts and retries recovery', async () => {
    const f = fixture();
    f.state.bytes = 1000n;
    f.state.delivered = false;
    await f.monitor.poll();
    await f.monitor.poll();
    expect(f.dependencies.notify).toHaveBeenCalledTimes(1);
    expect(f.dependencies.failure).toHaveBeenCalledTimes(1);
    f.state.bytes = 0n;
    await f.monitor.poll();
    expect(f.dependencies.notify).toHaveBeenCalledTimes(2);
    f.state.delivered = true;
    f.state.now += CAPACITY_REPEAT_MS;
    await f.monitor.poll();
    await f.monitor.poll();
    expect(f.dependencies.notify).toHaveBeenCalledTimes(3);
    await f.monitor.stop();
  });
  it('isolates missing paths and failed DB reads while other resources still warn', async () => {
    const f = fixture();
    f.dependencies.readDisk.mockImplementation(async (path) => {
      if (path === paths[0]) throw new Error('raw-private-path-canary');
      return critical;
    });
    f.dependencies.readDatabase.mockRejectedValue(new Error('raw-private-db-url-canary'));
    await f.monitor.poll();
    expect(f.dependencies.notify).toHaveBeenCalledTimes(3);
    const bodies = f.dependencies.notify.mock.calls.map((call) => call[1]).join('\n');
    expect(bodies.includes('canary') || bodies.includes(WEBHOOK)).toBe(false);
    expect(bodies).toContain('disk-2');
    expect(bodies).toContain('위험');
    expect(bodies).toContain('database');
    expect(bodies).toContain('조회 실패');
    await f.monitor.stop();
  });
});

describe('capacity timer and actual pending work settlement', () => {
  it('polls immediately then every five minutes and stops without later IO', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.readDatabase).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CAPACITY_POLL_MS);
    expect(f.dependencies.readDatabase).toHaveBeenCalledTimes(2);
    await f.monitor.stop();
    await vi.advanceTimersByTimeAsync(CAPACITY_POLL_MS);
    expect(f.dependencies.readDatabase).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('starts no queued reads or notifications when close happens before their microtask', async () => {
    const f = fixture();
    const poll = f.monitor.poll();
    const stop = f.monitor.stop();
    await Promise.all([poll, stop]);
    expect(f.dependencies.readDisk).not.toHaveBeenCalled();
    expect(f.dependencies.readDatabase).not.toHaveBeenCalled();
    expect(f.dependencies.notify).not.toHaveBeenCalled();
  });
  it('waits for an actual read and discards late alert results during shutdown', async () => {
    const f = fixture();
    const read = deferred<DiskSpace>();
    f.dependencies.readDisk.mockReturnValue(read.promise);
    const polling = f.monitor.poll();
    await Promise.resolve();
    let stopped = false;
    const stopping = f.monitor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    read.resolve(critical);
    await Promise.all([polling, stopping]);
    expect(stopped).toBe(true);
    expect(f.dependencies.notify).not.toHaveBeenCalled();
  });
  it('keeps a timed-out native read owned and blocks later polling until actual settlement', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const read = deferred<DiskSpace>();
    f.dependencies.readDisk.mockReturnValueOnce(read.promise);
    const polling = f.monitor.poll();
    await vi.advanceTimersByTimeAsync(CAPACITY_READ_MS);
    await polling;
    const count = f.dependencies.readDatabase.mock.calls.length;
    await f.monitor.poll();
    expect(f.dependencies.readDatabase).toHaveBeenCalledTimes(count);
    expect(f.dependencies.notify.mock.calls.some((call) => call[1].includes('조회 실패'))).toBe(true);
    read.resolve(healthy);
    await Promise.resolve();
    await f.monitor.stop();
  });
  it('rejects a finite close without pretending a still-pending native read settled', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const read = deferred<DiskSpace>();
    f.dependencies.readDisk.mockReturnValueOnce(read.promise);
    const polling = f.monitor.poll();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = f.monitor.stop();
    const rejection = expect(stopping).rejects.toThrow('용량 감시 종료를 확인하지 못했습니다.');
    await vi.advanceTimersByTimeAsync(CAPACITY_READ_MS);
    await rejection;
    await polling;
    expect(f.monitor.stop()).toBe(stopping);
    read.resolve(critical);
    await Promise.resolve();
    await f.monitor.poll();
    expect(f.dependencies.notify).not.toHaveBeenCalled();
  });
  it('aborts owned notification transport and waits for its actual promise', async () => {
    const f = fixture();
    f.state.bytes = 1000n;
    const delivery = deferred<boolean>();
    f.dependencies.notify.mockReturnValue(delivery.promise);
    const polling = f.monitor.poll();
    for (let i = 0; i < 10 && f.dependencies.notify.mock.calls.length === 0; i++) await Promise.resolve();
    const signal = f.dependencies.notify.mock.calls[0]![2];
    let stopped = false;
    const stopping = f.monitor.stop().then(() => {
      stopped = true;
    });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    delivery.resolve(false);
    await Promise.all([polling, stopping]);
    expect(stopped).toBe(true);
  });
  it('registers no lifecycle hooks and performs no additional IO when OFF', async () => {
    const db = createDb('postgresql://unused@127.0.0.1:1/unused');
    const server = fastify();
    const hook = vi.spyOn(server, 'addHook');
    const transaction = vi.spyOn(db, '$transaction');
    try {
      registerCapacityMonitor(server, db, null);
      expect(hook).not.toHaveBeenCalled();
      await server.ready();
      await server.close();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await server.close();
      await db.$disconnect();
    }
  });
});
