import { randomUUID } from 'node:crypto';
import { createDb } from '../packages/db/src/index';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { testDatabaseUrl } from './test-database';

// 전용 시험 DB의 커밋 직전 중단만 허용한다. 독립 Node 프로세스를 죽여 실제 PG 롤백을 검증한다.
const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
const worldId = process.env.HERITAGE_CRASH_WORLD;
if (!process.send || !/^\/heritage_[a-f0-9]{32}_test$/.test(url.pathname) || !worldId)
  throw new Error('유산 중단 시험의 전용 DB·월드·IPC를 확인하세요.');
process.once('disconnect', () => process.exit(2));
const db = createDb(url.href);
const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
if (world.name !== '유산 실제 처리 검증' || !world.ruleFeatures.includes('heritage-v1'))
  throw new Error('유산 중단 시험 월드가 아닙니다.');
const lease = await acquireLease(db, worldId, randomUUID(), 5000);
if (!lease) throw new Error('중단 시험 실행권이 없습니다.');
try {
  await new TurnLoop(db, lease, {
    beforeCommit: async () => {
      process.send!({ phase: 'BEFORE_COMMIT' });
      await new Promise<never>(() => {});
    },
  }).advanceTo(0);
} finally {
  await releaseLease(db, lease);
  await db.$disconnect();
}
