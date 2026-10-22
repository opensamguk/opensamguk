// GitHub 표준 실행기에서 같은 DB TurnLoop 경로의 처리량을 잰다.
import { createDb } from '../packages/db/src/index';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
let worldId: string | undefined;
try {
  const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: '1' });
  if (initial.cities.length !== 94 || initial.generals.length !== 491) throw new Error('전체 1030 리소스가 아닙니다.');
  ({ worldId } = await saveInitialWorld(db, initial, { name: 'T1-26 처리량', turnTermMinutes: 1, endYear: 300 }));
  await controlClock(db, worldId, 'start');
  await controlClock(db, worldId, 'accelerate');
  const lease = (await acquireLease(db, worldId))!;
  try {
    const loop = new TurnLoop(db, lease);
    const started = performance.now();
    let renewedAt = started;
    let batches = 0,
      maxBatch = 0;
    for (;;) {
      if (performance.now() - renewedAt > 4000) {
        await renewLease(db, lease);
        renewedAt = performance.now();
      }
      const batch = await loop.poll();
      batches++;
      maxBatch = Math.max(maxBatch, batch.executions.length);
      const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      if (world.monthlyTick >= 20000 || world.status === 'ENDED') break;
    }
    await controlClock(db, worldId, 'pause');
    const seconds = (performance.now() - started) / 1000;
    const generalTurns = await db.generalLog.count({ where: { worldId } });
    const months = await db.yearbookSnapshot.count({ where: { worldId } });
    const archive = await exportReplay(db, worldId);
    replayArchive(archive, months);
    console.log(
      JSON.stringify({
        source: process.env.GITHUB_SHA ?? null,
        runner: process.env.RUNNER_OS ?? 'local',
        node: process.version,
        scenario: '1030',
        seed: '1',
        cities: 94,
        generals: 491,
        endYear: 300,
        convergence: 'unchanged-engine-default',
        assistanceEligible: false,
        seconds,
        generalTurns,
        months,
        batches,
        maxBatch,
        generalTurnsPerSecond: generalTurns / seconds,
        monthsPerMinute: (months * 60) / seconds,
        projectedMonths: (300 - initial.startYear + 1) * 12,
        projectedSecondsToEndYear: ((300 - initial.startYear + 1) * 12 * seconds) / months,
        replayVerified: true,
        finalMonthlyHash: archive.months.at(-1)?.stateHash,
      }),
    );
  } finally {
    await releaseLease(db, lease);
  }
} finally {
  if (worldId) await db.world.delete({ where: { id: worldId } });
  await db.$disconnect();
}
