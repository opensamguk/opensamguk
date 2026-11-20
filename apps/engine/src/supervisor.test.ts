import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { PrismaClient } from '@opensamguk/db';
import { expect, it, vi } from 'vitest';
import { runSupervisor, type SupervisorEvent } from './supervisor';

it('records spawn failure reasons and world IDs without raw errors', async () => {
  const controller = new AbortController();
  const events: SupervisorEvent[] = [];
  const tx = {
    world: { findUnique: vi.fn().mockResolvedValue({ clockTick: 1 }) },
    engineHeartbeat: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const db = {
    world: { findMany: vi.fn().mockResolvedValue([{ id: 'world' }]) },
    $transaction: vi.fn(async (read: (value: typeof tx) => Promise<unknown>) => read(tx)),
  } as unknown as PrismaClient;
  await runSupervisor(db, {
    signal: controller.signal,
    spawnChild: () => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('error', Object.assign(new Error('secret'), { code: 'ENOENT' })));
      return child;
    },
    onEvent: (event) => {
      events.push(event);
      if (event.kind === 'retry') controller.abort();
    },
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      worldId: 'world',
      kind: 'retry',
      diagnostic: expect.objectContaining({ code: 'ENOENT' }),
    }),
  );
  expect(JSON.stringify(events)).not.toContain('secret');
});
