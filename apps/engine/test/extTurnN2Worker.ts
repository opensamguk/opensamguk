// T4-17의 실제 프로세스 종료 시험에서만 쓴다. 실행권과 턴은 제품 경로를 사용한다.
import { createDb } from '@opensamguk/db';
import { acquireLease } from '../src/lease';
import { TurnLoop } from '../src/turnLoop';
import { loadWorld } from '../src/worldLoader';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/t417_n2_[a-f0-9]{32}_test$/.test(new URL(url).pathname))
  throw new Error('시험이 만든 전용 DB가 필요합니다.');
const [worldId, phase] = process.argv.slice(2);
if (!worldId || !['saved', 'beforeCommit', 'committed'].includes(phase ?? ''))
  throw new Error('시험 단계가 올바르지 않습니다.');
const db = createDb(url);
const hold = () =>
  new Promise<void>(() => {
    /* 부모가 이 프로세스만 종료한다. */
  });
try {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  if (phase === 'saved') {
    await db.$transaction((tx) => loadWorld(tx, worldId));
    process.send?.('saved');
    await hold();
  } else {
    const loop = new TurnLoop(
      db,
      lease,
      phase === 'beforeCommit'
        ? {
            beforeCommit: async () => {
              process.send?.('beforeCommit');
              await hold();
            },
          }
        : {},
    );
    await loop.advanceTo(100);
    process.send?.('committed');
    await hold();
  }
} catch {
  // DB 연결 문자열을 포함할 수 있는 원본 오류는 IPC와 stderr에 싣지 않는다.
  process.send?.('failed');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
