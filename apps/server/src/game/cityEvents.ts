import { TICKS_PER_MONTH, citySeasonalEventInfo } from '@opensamguk/rules';

export function cityEvents(
  city: { conflictTick: number | null; stratagemTick: number | null; seasonalEvent: string | null },
  tick: number,
) {
  const current = Math.floor(tick / TICKS_PER_MONTH);
  const monthsLeft = (start: number | null, duration: number) =>
    start === null || start > tick ? 0 : Math.max(0, Math.floor(start / TICKS_PER_MONTH) + duration - current);
  const conflictMonths = monthsLeft(city.conflictTick, 3);
  const stratagemMonths = monthsLeft(city.stratagemTick, 2);
  return [
    ...(conflictMonths
      ? [{ kind: 'conflict' as const, name: '교전', favorable: false, monthsRemaining: conflictMonths }]
      : []),
    ...(stratagemMonths
      ? [{ kind: 'stratagem' as const, name: '계략 피해', favorable: false, monthsRemaining: stratagemMonths }]
      : []),
    ...(city.seasonalEvent ? [{ ...citySeasonalEventInfo(city.seasonalEvent), monthsRemaining: null }] : []),
  ];
}
