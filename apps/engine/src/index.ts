import { RULESET_ID } from '@opensamguk/rules';

// 턴 엔진 자리. 시계·리스·턴 실행은 AC-M1-10 ~ M1-13에서 만든다.
const HEARTBEAT_MS = 30_000;

console.log(`[engine] 시작 (ruleset: ${RULESET_ID})`);
const heartbeat = setInterval(() => {
  console.log('[engine] 대기 중');
}, HEARTBEAT_MS);

const shutdown = () => {
  clearInterval(heartbeat);
  console.log('[engine] 종료');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
