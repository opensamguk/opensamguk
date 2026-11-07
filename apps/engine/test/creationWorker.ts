// 실제 입력 트랜잭션을 commit 전후에 멈춰 부모가 SIGKILL한다.
import { createDb, type Prisma } from '@opensamguk/db';
import { acquireLease } from '../src/lease';
import { TurnLoop } from '../src/turnLoop';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const worldId = process.argv[2]!;
const phase = process.argv[3]!;
const tick = Number(process.argv[4] ?? 0);
const inputId = process.argv[5] === undefined ? undefined : BigInt(process.argv[5]);
if (!Number.isSafeInteger(tick) || tick < 0) throw new Error('입력 중단 시험 시각이 올바르지 않습니다.');
const db = createDb(url);
async function reached(tx: Pick<Prisma.TransactionClient, 'inputEvent'>) {
  return (
    inputId === undefined ||
    Boolean(
      await tx.inputEvent.findFirst({
        where: { worldId, id: inputId, status: 'APPLIED' },
        select: { id: true },
      }),
    )
  );
}
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
          if (!(await reached(tx))) return;
          process.send?.('beforeCommit');
          await hold();
        },
      }
    : {},
);
await loop.advanceTo(tick);
if (!(await reached(db))) throw new Error('중단할 입력의 완료 상태를 찾지 못했습니다.');
process.send?.('committed');
await hold();
