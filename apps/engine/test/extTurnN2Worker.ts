// T4-17의 실제 프로세스 종료 시험에서만 쓴다. 실행권과 턴은 제품 경로를 사용한다.
import { createDb } from '@opensamguk/db';
import { acquireLease } from '../src/lease';
import { TurnLoop } from '../src/turnLoop';
import { loadWorld } from '../src/worldLoader';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('시험이 만든 전용 DB가 필요합니다.');
const approved = new URL(url);
const assigned = process.env.CI_GREEN_DATABASE;
// CI의 DATABASE_URL은 승인한 시험 DB의 미러다. 일반 실행에서는 개발 DB와 비교한다.
const development = !assigned && process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : undefined;
const host = (value: URL) => (value.hostname === 'localhost' ? '127.0.0.1' : value.hostname);
// testDatabaseUrl과 같은 이름·개발 DB 경계다. 시험 실행기는 tools에 의존하지 않는다.
if (
  !['postgres:', 'postgresql:'].includes(approved.protocol) ||
  (!/^[a-z][a-zA-Z0-9_]*_test$/.test(approved.pathname.slice(1)) && approved.pathname !== '/opensamguk_ci_green') ||
  (development &&
    host(development) === host(approved) &&
    (development.port || '5432') === (approved.port || '5432') &&
    development.pathname === approved.pathname)
)
  throw new Error('개발 DB와 다른 전용 시험 DB가 필요합니다.');
if (assigned && (!/^opensamguk_ci_green_[a-z0-9]+_test$/.test(assigned) || approved.pathname !== '/' + assigned))
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
