import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { monthlyFixture } from '../test/monthlyFixture';
import { saveInitialWorld } from './world/persistence';
import { controlClock } from './world/clock';
import { exportReplay, replayArchive } from './replay';
import { prepareSeasonWorld } from '../test/seasonFixture';
import { runSupervisor, type SupervisorEvent } from './supervisor';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url),
  worlds: string[] = [],
  users: string[] = [];
afterAll(async () => {
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});
async function until(check: () => Promise<boolean> | boolean, timeout = 25000) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error('가속 운영 경계 시간 초과');
    await delay(30);
  }
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
}
function worker(worldId: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/test/acceleratedWorker.ts', worldId], {
    cwd: new URL('../../../', import.meta.url),
    env: { ...process.env, TEST_DATABASE_URL: url },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const batches: { batch: number; count: number; more: boolean; startedAt: number; finishedAt: number }[] = [];
  child.on('message', (batch: (typeof batches)[number]) => batches.push(batch));
  return { child, batches };
}

it('실제 가속 자식은 배치·리스 갱신·2초 정지·재개·SIGKILL 재시작 동안 같은 판을 이어 간다', async () => {
  const user = await db.user.create({ data: { email: 'accelerated-worker@test.invalid', passwordHash: 'test-only' } });
  users.push(user.id);
  const initial = await monthlyFixture();
  initial.generals = [{ ...initial.generals[0]!, userId: user.id }];
  const { worldId } = await saveInitialWorld(db, initial, {
    replayFormat: 'legacy',
    name: '끝없는 가속 시험',
    turnTermMinutes: 60,
    endYear: null,
  });
  worlds.push(worldId);
  await controlClock(db, worldId, 'start');
  await controlClock(db, worldId, 'accelerate');
  const first = worker(worldId);
  try {
    await until(() => first.batches.length >= 3);
    expect(first.batches.slice(0, 3).every((batch) => batch.more && batch.count <= 64)).toBe(true);
    for (let i = 1; i < 3; i++)
      expect(first.batches[i]!.startedAt - first.batches[i - 1]!.finishedAt).toBeLessThan(100);
    const original = await db.engineLease.findUniqueOrThrow({ where: { worldId } });
    await until(
      async () => (await db.engineLease.findUniqueOrThrow({ where: { worldId } })).expiresAt > original.expiresAt,
      10000,
    );
    expect((await db.engineLease.findUniqueOrThrow({ where: { worldId } })).fencingToken).toBe(original.fencingToken);
    const paused = await controlClock(db, worldId, 'pause');
    await delay(2000);
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick).toBe(paused.tick);
    await controlClock(db, worldId, 'resume');
    await until(async () => (await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick > paused.tick);
    await kill(first.child);
    const stopped = (await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick;
    const second = worker(worldId);
    try {
      await until(
        async () =>
          (await db.engineLease.findUniqueOrThrow({ where: { worldId } })).fencingToken > original.fencingToken,
        22000,
      );
      await until(async () => (await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick > stopped);
      await controlClock(db, worldId, 'pause');
      expect(
        await db.$queryRaw`SELECT "generalId",tick,COUNT(*) FROM "GeneralLog" WHERE "worldId" = ${worldId} GROUP BY "generalId",tick HAVING COUNT(*) > 1`,
      ).toEqual([]);
      expect(
        await db.$queryRaw`SELECT tick FROM (SELECT tick,lag(tick) OVER (ORDER BY tick) AS previous FROM "GeneralLog" WHERE "worldId" = ${worldId}) q WHERE previous IS NOT NULL AND tick - previous <> 10000`,
      ).toEqual([]);
      const archive = await exportReplay(db, worldId);
      expect(replayArchive(archive, 3)).toHaveLength(3);
    } finally {
      await kill(second.child);
    }
  } finally {
    await kill(first.child);
  }
}, 60000);

it('감독은 엔진의 실제 ENDED 정상 종료를 충돌로 세지 않고 heartbeat를 멈춘다', async () => {
  const { worldId } = await prepareSeasonWorld(db, 'END_YEAR');
  worlds.push(worldId);
  await controlClock(db, worldId, 'accelerate');
  const controller = new AbortController(),
    events: SupervisorEvent[] = [];
  const running = runSupervisor(db, { signal: controller.signal, onEvent: (event) => events.push(event) });
  try {
    await until(async () => (await db.world.findUniqueOrThrow({ where: { id: worldId } })).status === 'ENDED');
    await delay(1200);
    expect(events.filter((event) => event.worldId === worldId && ['retry', 'halted'].includes(event.kind))).toEqual([]);
    const heartbeat = await db.engineHeartbeat.findUniqueOrThrow({ where: { worldId } });
    expect(heartbeat.lastError).toBeNull();
    await delay(1100);
    expect(await db.engineHeartbeat.findUniqueOrThrow({ where: { worldId } })).toEqual(heartbeat);
  } finally {
    controller.abort();
    await running;
  }
});
