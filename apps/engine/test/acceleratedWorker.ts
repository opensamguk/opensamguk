import { createDb } from '@opensamguk/db';
import { runEngine } from '../src/main';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
let batches = 0;
try {
  await runEngine(db, {
    worldId: process.argv[2]!,
    signal: controller.signal,
    onBatch: (batch, timing) => {
      batches++;
      if (batches <= 4 || !batch.more)
        process.send?.({
          batch: batches,
          count: batch.executions.length,
          more: batch.more,
          status: batch.status,
          ...timing,
        });
    },
  });
} finally {
  await db.$disconnect();
}
