import { toGameDate } from '../clock/clock';
import { TICKS_PER_MONTH } from '../clock/constants';

function validateTarget(startYear: number, targetYear: number, targetMonth: number) {
  if (
    !Number.isSafeInteger(startYear) ||
    !Number.isSafeInteger(targetYear) ||
    !Number.isInteger(targetMonth) ||
    targetMonth < 1 ||
    targetMonth > 12
  )
    throw new Error('잘못된 작전 목표 연월입니다.');
}

export function operationTargetTick(startYear: number, targetYear: number, targetMonth: number): number {
  validateTarget(startYear, targetYear, targetMonth);
  const months = (targetYear - startYear) * 12 + targetMonth - 1;
  const tick = months * TICKS_PER_MONTH;
  if (!Number.isSafeInteger(months) || !Number.isSafeInteger(tick) || tick < 0)
    throw new Error('작전 목표 tick이 게임 시계 범위를 벗어났습니다.');
  return tick;
}

export function isPastOperationTarget(
  startYear: number,
  tick: number,
  targetYear: number,
  targetMonth: number,
): boolean {
  validateTarget(startYear, targetYear, targetMonth);
  const current = toGameDate(startYear, tick);
  return targetYear < current.year || (targetYear === current.year && targetMonth < current.month);
}
