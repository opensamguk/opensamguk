// IPC로 사건을 관측하고 Windows 종료를 요청한다. 감독과 자식은 운영 경로를 쓴다.
import { createDb } from '@opensamguk/db';
import { engineFailureMessage } from '../src/main';
import { runSupervisor } from '../src/supervisor';
import { onShutdownRequest } from '../src/process-lifecycle';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const controller = new AbortController();
const shutdown = () => controller.abort();
const removeShutdown = onShutdownRequest(shutdown);
try {
  await runSupervisor(db, {
    signal: controller.signal,
    onEvent: (event) => process.send?.(event),
  });
} catch (error) {
  console.error(engineFailureMessage(error));
  process.exitCode = 1;
} finally {
  removeShutdown();
  try {
    await db.$disconnect();
  } finally {
    process.disconnect?.();
  }
}
