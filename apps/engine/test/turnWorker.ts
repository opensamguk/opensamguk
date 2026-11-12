// 실제 프로세스 종료가 열린 트랜잭션과 이미 commit된 턴에 미치는 영향을 검증한다.
import { createDb } from '@opensamguk/db';
import { acquireLease } from '../src/lease';
import { TurnLoop } from '../src/turnLoop';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const worldId = process.argv[2]!;
const phase = process.argv[3]!;
const target = process.argv[4];
const commandKey = process.argv[5];
const inputArg = process.argv[6];
const inputId = inputArg === undefined ? undefined : BigInt(inputArg);
if (inputId !== undefined && inputId < 1n) throw new Error('양의 정수 입력 ID가 필요합니다.');
const tick = Number(target ?? 500);
if (!Number.isSafeInteger(tick) || tick < 0) throw new Error('0 이상의 정수 tick이 필요합니다.');
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
            // 대상을 지정한 시험은 해당 효과를 쓴 트랜잭션에서 멈춘다.
            if (commandKey && !(await tx.generalLog.count({ where: { worldId, tick, commandKey } }))) return;
            if (
              inputId !== undefined &&
              !(await tx.inputEvent.count({ where: { worldId, id: inputId, status: 'APPLIED' } }))
            )
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
