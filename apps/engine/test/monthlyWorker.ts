// 실제 월간 정산 트랜잭션을 commit 전후에 멈춰 부모가 SIGKILL한다.
import { createDb } from '@opensamguk/db';
import { TICKS_PER_MONTH } from '@opensamguk/rules';
import { acquireLease } from '../src/lease';
import { TurnLoop } from '../src/turnLoop';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const worldId = process.argv[2]!;
const phase = process.argv[3]!;
const tick = Number(process.argv[4] ?? TICKS_PER_MONTH);
if (!Number.isSafeInteger(tick) || tick <= 0 || tick % TICKS_PER_MONTH !== 0)
  throw new Error('월 정산 시험 시각이 올바르지 않습니다.');
const db = createDb(url);
const lease = await acquireLease(db, worldId);
if (!lease) throw new Error('리스가 필요합니다.');
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
          if (await tx.yearbookSnapshot.findUnique({ where: { worldId_tick: { worldId, tick } } })) {
            process.send?.('beforeCommit');
            await hold();
          }
        },
      }
    : {},
);
await loop.advanceTo(tick);
process.send?.('committed');
await hold();
