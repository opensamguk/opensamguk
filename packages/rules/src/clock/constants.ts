// T1-04의 시계 단위. 시나리오 외교 기간도 같은 단위를 쓴다.
export const TICKS_PER_MONTH = 10_000;
// 다음 장수 차례를 계산해도 PostgreSQL 정수 범위를 넘지 않는 실행 상한이다.
export const MAX_ADVANCE_TICK = 2_147_483_647 - TICKS_PER_MONTH;
