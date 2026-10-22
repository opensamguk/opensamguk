import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { prepareSeasonWorld, seasonInitial } from '../test/seasonFixture';
import { saveInitialWorld } from './world/persistence';
import { acquireLease, releaseLease } from './lease';
import { controlClock } from './world/clock';
import { loadReplayState } from './monthly';
import { exportReplay, replayToEnd } from './replay';
import { TurnLoop } from './turnLoop';
import { runEngine } from './main';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worlds: string[] = [];
afterAll(async () => {
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.$disconnect();
});
async function fixture(reason: 'END_YEAR' | 'UNIFIED') {
  const result = await prepareSeasonWorld(db, reason);
  worlds.push(result.worldId);
  return result;
}
async function evidence(worldId: string) {
  return {
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    result: await db.worldResult.findUnique({ where: { worldId } }),
    replay: await db.$transaction((tx) => loadReplayState(tx, worldId)),
    logs: await db.generalLog.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    months: await db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } }),
    events: await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
  };
}
async function checkEnd(worldId: string, reason: 'END_YEAR' | 'UNIFIED') {
  const value = await evidence(worldId);
  const result = value.result!;
  expect(value.world.status).toBe('ENDED');
  expect(value.world.endedAt).toEqual(result.endedAt);
  expect(result.reason).toBe(reason);
  expect(result.winnerNationId).toBe(reason === 'UNIFIED' ? 1 : null);
  expect(hashState(value.replay)).toBe(result.finalStateHash);
  const archive = await exportReplay(db, worldId);
  expect(replayToEnd(JSON.parse(JSON.stringify(archive)))).toEqual(archive.end);
  expect(value.world.actionSequence).toBe(result.endedSequence + archive.afterEnd.length);
  expect(value.logs.every((log) => log.tick <= result.endedTick)).toBe(true);
  expect(value.months.every((month) => month.tick <= result.endedTick)).toBe(true);
  if (reason === 'UNIFIED') {
    expect(archive.months).toHaveLength(0);
    expect(value.logs).toHaveLength(1);
    expect(value.logs[0]?.text).toContain('점령');
    expect(result.winnerName).toBeTruthy();
    expect(result.winnerColor).toBeTruthy();
  } else {
    expect(result.endedMonth).toBe(12);
    expect(value.months).toHaveLength(12);
    expect(result.finalStateHash).toBe(value.months.at(-1)?.stateHash);
  }
  return value;
}

for (const reason of ['END_YEAR', 'UNIFIED'] as const) {
  describe(`AC-M1-21 ${reason} 실제 PostgreSQL`, () => {
    it('결정 사건·결과를 원자적으로 한 번 저장하고 재생하며 종료 뒤 게임 쓰기가 없다', async () => {
      const { worldId } = await fixture(reason);
      const lease = (await acquireLease(db, worldId))!;
      try {
        const loop = new TurnLoop(db, lease);
        await loop.advanceTo(120000);
        const value = await checkEnd(worldId, reason);
        await loop.advanceTo(130000);
        expect(await evidence(worldId)).toEqual(value);
      } finally {
        await releaseLease(db, lease);
      }
    });
    it('beforeCommit 오류는 종료 사건 전체를 롤백하고 재시도는 한 번만 끝난다', async () => {
      const { worldId } = await fixture(reason);
      const lease = (await acquireLease(db, worldId))!;
      try {
        const loop = new TurnLoop(db, lease, {
          beforeCommit: async (tx) => {
            if (await tx.worldResult.findUnique({ where: { worldId } })) throw new Error('종료 롤백 탐침');
          },
        });
        await expect(loop.advanceTo(120000)).rejects.toThrow('종료 롤백 탐침');
        expect(await db.worldResult.count({ where: { worldId } })).toBe(0);
        expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).status).toBe('RUNNING');
        expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(reason === 'END_YEAR' ? 11 : 0);
        expect(await db.generalLog.count({ where: { worldId } })).toBe(0);
        await new TurnLoop(db, lease).advanceTo(120000);
        await checkEnd(worldId, reason);
      } finally {
        await releaseLease(db, lease);
      }
    });
    for (const phase of ['beforeCommit', 'committed']) {
      it(`SIGKILL ${phase} 뒤 새 프로세스는 더 큰 펜싱으로 단일 결과를 남긴다`, async () => {
        const { worldId } = await fixture(reason);
        const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/test/seasonWorker.ts', worldId, phase], {
          cwd: new URL('../../../', import.meta.url),
          env: { ...process.env, TEST_DATABASE_URL: url },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        try {
          const token = await new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('종료 자식 경계 시간 초과')), 20000);
            child.on('message', (value: { phase: string; token: number }) => {
              if (value.phase === phase) {
                clearTimeout(timeout);
                resolve(value.token);
              }
            });
            child.once('exit', () => {
              clearTimeout(timeout);
              reject(new Error('시험 자식 조기 종료'));
            });
          });
          const exit = once(child, 'exit');
          child.kill('SIGKILL');
          await exit;
          expect(await db.worldResult.count({ where: { worldId } })).toBe(phase === 'committed' ? 1 : 0);
          await delay(5100);
          // 재시작도 별도 OS 프로세스에서 실행한다.
          const restarted = spawn(
            process.execPath,
            ['--import', 'tsx', 'apps/engine/test/seasonWorker.ts', worldId, 'committed'],
            {
              cwd: new URL('../../../', import.meta.url),
              env: { ...process.env, TEST_DATABASE_URL: url },
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            },
          );
          try {
            const next = await new Promise<number>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('재시작 시간 초과')), 20000);
              restarted.on('message', (value: { phase: string; token: number }) => {
                if (value.phase === 'committed') {
                  clearTimeout(timeout);
                  resolve(value.token);
                }
              });
            });
            expect(next).toBeGreaterThan(token);
            await checkEnd(worldId, reason);
            expect(await db.worldResult.count({ where: { worldId } })).toBe(1);
          } finally {
            await kill(restarted);
          }
        } finally {
          await kill(child);
        }
      }, 45000);
    }
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
}

it('종료 연도 정산과 같은 tick인 장수 턴은 실행하지 않는다', async () => {
  const initial = await seasonInitial('END_YEAR');
  const template = await seasonInitial('UNIFIED');
  initial.generals = [
    { ...template.generals[0]!, nationId: 1, cityKey: 1, crew: 0, gold: 0, rice: 0, nextTurnTick: 120000 },
  ];
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '경계',
    turnTermMinutes: 60,
    endYear: initial.startYear,
  });
  worlds.push(worldId);
  await controlClock(db, worldId, 'start');
  const lease = (await acquireLease(db, worldId))!;
  try {
    await new TurnLoop(db, lease).advanceTo(120000);
    expect(await db.generalLog.count({ where: { worldId } })).toBe(0);
    await checkEnd(worldId, 'END_YEAR');
  } finally {
    await releaseLease(db, lease);
  }
});

it('가속 모드·정지·재개·realtime 복귀는 같은 월드 tick을 보존한다', async () => {
  const { worldId } = await fixture('END_YEAR');
  await controlClock(db, worldId, 'pause', 0);
  const before = await controlClock(db, worldId, 'accelerate', 1000);
  expect(before.clockMode).toBe('ACCELERATED');
  expect((await controlClock(db, worldId, 'status', 2000)).tick).toBe(before.tick);
  await controlClock(db, worldId, 'resume', 3000);
  expect((await controlClock(db, worldId, 'status', 4000)).tick).toBe(before.tick);
  const realtime = await controlClock(db, worldId, 'realtime', 5000);
  expect(realtime.tick).toBe(before.tick);
  expect((await controlClock(db, worldId, 'status', 5000)).tick).toBe(before.tick);
  expect((await controlClock(db, worldId, 'status', 8600)).tick).toBe(before.tick + 10);
});

it('가속 poll은 배치마다 반환하고 runEngine은 종료 후 리스를 놓고 정상 종료한다', async () => {
  const { worldId } = await fixture('END_YEAR');
  await controlClock(db, worldId, 'accelerate');
  await runEngine(db, { worldId, signal: AbortSignal.timeout(15000) });
  await checkEnd(worldId, 'END_YEAR');
  const lease = await acquireLease(db, worldId);
  expect(lease).not.toBeNull();
  if (lease) await releaseLease(db, lease);
});

it('운영 모드는 PREOPEN·ENDED·같은 모드를 거부하고 동시 전환은 한 번 적용한다', async () => {
  const initial = await seasonInitial('END_YEAR');
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '거부',
    turnTermMinutes: 60,
    endYear: initial.startYear,
  });
  worlds.push(worldId);
  await expect(controlClock(db, worldId, 'accelerate')).rejects.toThrow();
  await controlClock(db, worldId, 'start');
  await expect(controlClock(db, worldId, 'realtime')).rejects.toThrow();
  const changes = await Promise.allSettled([
    controlClock(db, worldId, 'accelerate'),
    controlClock(db, worldId, 'accelerate'),
  ]);
  expect(changes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const lease = (await acquireLease(db, worldId))!;
  try {
    await new TurnLoop(db, lease).advanceTo(120000);
  } finally {
    await releaseLease(db, lease);
  }
  await expect(controlClock(db, worldId, 'realtime')).rejects.toThrow();
});
