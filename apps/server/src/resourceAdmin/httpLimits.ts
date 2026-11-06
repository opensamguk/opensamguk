import { RESOURCE_PAYLOAD_LIMITS } from './payload';

// 서버의 경로 5,000자와 고정 오류 구조를 JSON 이스케이프해도 봉투 64KiB 안이다.
export const RESOURCE_HTTP_LIMITS = Object.freeze({
  batchMax: 4,
  errorMessageMax: 1024,
  envelopeMax: 64 * 1024,
  wireMax: 4 * (RESOURCE_PAYLOAD_LIMITS.responseMax + 64 * 1024) + 5,
});
