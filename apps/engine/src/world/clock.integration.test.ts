import { execFileSync } from 'node:child_process';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { controlClock } from './clock';
import { loadInitialWorld } from './resources';
import { saveInitialWorld } from './persistence';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
beforeAll(async () => {
  await db.world.deleteMany();
});
afterAll(async () => {
  await db.world.deleteMany();
  await db.$disconnect();
});
async function create() {
  return saveInitialWorld(db, await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'clock' }), {
    name: '시계',
    turnTermMinutes: 10,
    endYear: null,
  });
}
describe('AC-M1-04 실제 DB 시계', () => {
  it('시작·정지·역행·재개를 저장하고 정지 동안 tick이 고정된다', async () => {
    const { worldId } = await create();
    await controlClock(db, worldId, 'start', 0);
    expect((await controlClock(db, worldId, 'status', 600_000)).tick).toBe(10_000);
    expect((await controlClock(db, worldId, 'status', 300_000)).tick).toBe(10_000);
    await controlClock(db, worldId, 'pause', 600_000);
    expect((await controlClock(db, worldId, 'status', 4_200_000)).tick).toBe(10_000);
    await controlClock(db, worldId, 'resume', 4_200_000);
    expect((await controlClock(db, worldId, 'status', 4_500_000)).tick).toBe(15_000);
  });
  it('동시 일시정지는 한 번만 적용한다', async () => {
    const { worldId } = await create();
    await controlClock(db, worldId, 'start', 0);
    const results = await Promise.allSettled([
      controlClock(db, worldId, 'pause', 60_000),
      controlClock(db, worldId, 'pause', 60_000),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await controlClock(db, worldId, 'status', 100_000)).status).toBe('PAUSED');
  });
  it('명령줄 create → start → pause → status → resume가 동작한다', async () => {
    const { worldId } = await create();
    const run = (action: string) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ['--import', 'tsx', 'apps/engine/src/cli/controlWorld.ts', action, '--world', worldId],
          {
            cwd: new URL('../../../../', import.meta.url),
            env: { ...process.env, DATABASE_URL: url },
            encoding: 'utf8',
            timeout: 30_000,
          },
        )
          .trim()
          .split('\n')
          .at(-1)!,
      ) as { status: string; tick: number; clockMode: string; endYear: number | null };
    expect(run('start').status).toBe('RUNNING');
    const paused = run('pause');
    expect(run('status').tick).toBe(paused.tick);
    expect(run('resume').status).toBe('RUNNING');
    expect(run('accelerate').clockMode).toBe('ACCELERATED');
    const acceleratedPause = run('pause');
    expect(run('status').tick).toBe(acceleratedPause.tick);
    expect(run('resume').clockMode).toBe('ACCELERATED');
    expect(run('realtime').clockMode).toBe('REALTIME');
    expect(run('status').endYear).toBeNull();
  });
});
