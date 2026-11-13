import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect } from 'vitest';
import { createDb, type PrismaClient } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay } from '../apps/engine/src/replay';

export async function runTurnWorkerAndKill(
  db: PrismaClient,
  url: string,
  worldId: string,
  phase: 'beforeCommit' | 'committed',
  turn?: { tick: number } & ({ commandKey: string; inputId?: never } | { commandKey?: never; inputId: bigint }),
) {
  const previous = await db.engineLease.findUnique({ where: { worldId } });
  const args = ['--import', 'tsx', 'apps/engine/test/turnWorker.ts', worldId, phase];
  if (turn) {
    args.push(String(turn.tick), turn.commandKey ?? '');
    if (turn.inputId !== undefined) args.push(String(turn.inputId));
  }
  const child = spawn(process.execPath, args, {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, TEST_DATABASE_URL: url },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  const closed = once(child, 'close');
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
      closed.then(() => {
        throw new Error('지정한 턴 실행 단계에 도달하기 전에 프로세스가 끝났습니다.');
      }),
    ]);
    expect(message).toBe(phase);
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual([null, 'SIGKILL']);
  } finally {
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill('SIGKILL');
    await closed;
  }
  const lease = await db.engineLease.findUniqueOrThrow({ where: { worldId } });
  expect(lease.fencingToken).toBeGreaterThan(previous?.fencingToken ?? 0);
  await db.engineLease.update({
    where: { worldId, fencingToken: lease.fencingToken },
    data: { expiresAt: new Date(0) },
  });
  return lease.fencingToken;
}

export async function expectSeparateProcessReplay(db: PrismaClient, url: string, worldId: string, months: number) {
  const archive = await exportReplay(db, worldId);
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs'; import {replayArchive} from './apps/engine/src/replay.ts'; const a=JSON.parse(readFileSync(0,'utf8')); console.log(JSON.stringify(replayArchive(a,a.months.length)));",
    ],
    {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '' },
      input: JSON.stringify(archive),
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  expect(archive.months).toHaveLength(months);
  expect(JSON.parse(output)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  const live = await db.$transaction((tx) => loadReplayState(tx, worldId), { isolationLevel: 'RepeatableRead' });
  expect(archive.months.at(-1)!.stateHash).toBe(hashState(live));
  const reopened = createDb(url);
  try {
    expect(hashState(await loadReplayState(reopened, worldId))).toBe(hashState(live));
  } finally {
    await reopened.$disconnect();
  }
}
