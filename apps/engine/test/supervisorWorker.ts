// IPC는 테스트 관측에만 쓴다. 감독과 자식은 운영 경로 그대로 실행한다.
import { createDb } from '@opensamguk/db';
import { engineFailureMessage } from '../src/main';
import { runSupervisor } from '../src/supervisor';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const controller = new AbortController();
const shutdown = () => controller.abort();
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
try {
  await runSupervisor(db, {
    signal: controller.signal,
    onEvent: (event) => process.send?.(event),
  });
} catch (error) {
  console.error(engineFailureMessage(error));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
  process.off('SIGTERM', shutdown);
  process.off('SIGINT', shutdown);
  process.disconnect?.();
}
