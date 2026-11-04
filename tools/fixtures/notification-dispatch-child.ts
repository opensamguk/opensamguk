import { createDb } from '../../packages/db/src/index';
import { dispatchNotificationBatch } from '../../apps/server/src/notifications/dispatcher';
import { testDatabaseUrl } from '../test-database';

const phase = process.argv[2];
const target = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
const receiver = new URL(process.env.NOTIFICATION_FIXTURE_RECEIVER ?? '');
if (
  process.env.NODE_ENV === 'production' ||
  !['claimed', 'observed', 'run'].includes(phase ?? '') ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.search ||
  receiver.protocol !== 'http:' ||
  receiver.hostname !== '127.0.0.1' ||
  receiver.origin !== process.env.NOTIFICATION_FIXTURE_RECEIVER
)
  throw Error('자기 알림 시험 환경을 확인하세요.');
const db = createDb(target.href);
async function notify(value: { stage: string }) {
  if (!process.send) throw Error('시험 IPC가 필요합니다.');
  await new Promise<void>((resolve, reject) => process.send!(value, (error) => (error ? reject(error) : resolve())));
}
const hold = async () => {
  await notify({ stage: phase! });
  await new Promise<never>(() => {});
};
try {
  await dispatchNotificationBatch(db, {
    publicOrigin: 'http://127.0.0.1:5173',
    transport: (_url, init) => fetch(receiver.origin + '/trial', init),
    ...(phase === 'claimed' ? { afterClaim: hold } : phase === 'observed' ? { beforeResult: hold } : {}),
  });
  await notify({ stage: 'done' });
} catch {
  console.error('알림 시험 자식 실행 실패');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
