// 전투 시뮬레이터 Worker (T4-34). 같은 출처의 별도 파일로 묶인다 (CSP script-src 'self').
// 받은 메시지는 compute가 다시 검사한다. 예상하지 못한 예외는 FAILED로 답하고 한국어 문장은 보내지 않는다.
import { createCompute } from './compute';
import { PUBLIC_UNIT_SET } from './publicUnitSet';
import { readRequestId, type BattleRunReply } from './request';

const compute = createCompute(PUBLIC_UNIT_SET);

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  let reply: BattleRunReply;
  try {
    reply = compute(event.data);
  } catch {
    reply = { type: 'error', requestId: readRequestId(event.data), code: 'FAILED' };
  }
  self.postMessage(reply);
});
