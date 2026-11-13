// 실제 프로세스 종료가 열린 트랜잭션과 이미 commit된 턴에 미치는 영향을 검증한다.
import { createDb } from '@opensamguk/db';
import { acquireLease } from '../src/lease';
import { TurnLoop } from '../src/turnLoop';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const worldId = process.argv[2]!;
const phase = process.argv[3]!;
const tick = Number(process.argv[4] ?? 500);
const commandKey = process.argv[5];
if (!Number.isSafeInteger(tick) || tick < 0) throw new Error('중단 시험 시각이 올바르지 않습니다.');
const db = createDb(url);
const lease = await acquireLease(db, worldId);
if (!lease) {
  process.send?.('waiting');
  await db.$disconnect();
} else {
  const hold = () =>
    new Promise<void>(() => {
      /* 부모가 SIGKILL한다. */
    });
  const loop = new TurnLoop(
    db,
    lease,
    phase === 'beforeCommit'
      ? {
          beforeCommit: async (tx) => {
            if (commandKey && !(await tx.generalLog.count({ where: { worldId, tick, commandKey, kind: 'success' } })))
              return;
            process.send?.('beforeCommit');
            await hold();
          },
        }
      : {},
  );
  await loop.advanceTo(tick);
  process.send?.('committed');
  await hold();
}
