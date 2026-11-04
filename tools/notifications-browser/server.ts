import { startNotificationFixture } from './fixture';

try {
  const fixture = await startNotificationFixture(process.env);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await fixture.close();
    } catch {
      console.error('알림 시험 서버 정리에 실패했습니다.');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch {
  console.error('알림 시험 서버 준비에 실패했습니다.');
  process.exitCode = 1;
}
