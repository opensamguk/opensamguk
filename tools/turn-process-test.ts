import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect } from 'vitest';
import type { PrismaClient } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadReplayState } from '../apps/engine/src/monthly';

export const turnCrashPhases = ['beforeCommit', 'committed'] as const;

export async function recoverTurnAfterCrash(
  db: PrismaClient,
  url: URL,
  worldId: string,
  generalId: number,
  tick: number,
  commandKey: string,
  phase: (typeof turnCrashPhases)[number],
) {
  const snapshot = () => db.$transaction((tx) => loadReplayState(tx, worldId), { isolationLevel: 'RepeatableRead' });
  const before = await snapshot();
  expect(before.turns[generalId]![0]).toMatchObject({ commandKey });
  const options = { cwd: new URL('../', import.meta.url), env: { ...process.env, TEST_DATABASE_URL: url.href } };
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/engine/test/turnWorker.ts', worldId, phase, String(tick), commandKey],
    { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true },
  );
  const closed = once(child, 'close');
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
      closed.then(() => {
        throw new Error('턴 중단 지점 전에 프로세스가 끝났습니다.');
      }),
    ]);
    expect(message).toBe(phase);
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual([null, 'SIGKILL']);
  } finally {
    if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }

  const logs = () => db.generalLog.findMany({ where: { worldId, generalId, tick, commandKey } });
  expect(await logs()).toHaveLength(phase === 'committed' ? 1 : 0);
  const interrupted = await snapshot();
  if (phase === 'beforeCommit') expect(interrupted).toEqual(before);
  const oldLease = await db.engineLease.findUniqueOrThrow({ where: { worldId } });
  await db.engineLease.update({
    where: { worldId, fencingToken: oldLease.fencingToken },
    data: { expiresAt: new Date(0) },
  });
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'apps/engine/test/presetWorker.ts', worldId, String(tick)],
    { ...options, encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  const recovered = await snapshot();
  expect(JSON.parse(output)).toMatchObject({ beforeHash: hashState(interrupted), afterHash: hashState(recovered) });
  expect((await db.engineLease.findUniqueOrThrow({ where: { worldId } })).fencingToken).toBeGreaterThan(
    oldLease.fencingToken,
  );
  expect(recovered.revisions[generalId]).toBe(before.revisions[generalId]! + 1);
  expect(recovered.turns[generalId]![0]!.commandKey).not.toBe(commandKey);
  expect((await logs()).map(({ kind }) => kind)).toEqual(['success']);
  if (phase === 'committed') expect(recovered).toEqual(interrupted);
  return recovered;
}
