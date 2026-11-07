// T1-04의 시계 단위. 시나리오 외교 기간도 같은 단위를 쓴다.
export const TICKS_PER_MONTH = 10_000;
// PostgreSQL 정수 상한에서 다음 장수 차례에 쓸 한 달(10,000 tick)을 뺀다.
export const MAX_ADVANCE_TICK = 2_147_473_647;
