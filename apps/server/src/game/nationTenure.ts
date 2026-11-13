import { TICKS_PER_MONTH } from '@opensamguk/rules';

export function nationTenureYears(joinedTick: number | null, tick: number): number | undefined {
  if (joinedTick === null || joinedTick > tick) return undefined;
  const ticksPerYear = TICKS_PER_MONTH * 12;
  return Math.floor(tick / ticksPerYear) - Math.floor(joinedTick / ticksPerYear) + 1;
}
