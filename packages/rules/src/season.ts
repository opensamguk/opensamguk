import type { WorldState } from './model/world';
import { isWandering } from './nationLifecycle/state';

export function unifiedNation(state: WorldState): number | null {
  const nations = Object.values(state.nations).filter((nation) => !isWandering(state, nation.id));
  const cities = Object.values(state.cities).filter(
    (city) => city.kind !== 'PASS' && city.kind !== 'FIELD' && (city.state == null || city.level >= 5),
  );
  if (Object.values(state.cities).some((city) => city.state != null)) {
    const owner = cities[0]?.nationId;
    return owner != null &&
      nations.some((nation) => nation.id === owner) &&
      cities.every((city) => city.nationId === owner)
      ? owner
      : null;
  }
  return nations.length === 1 && cities.length > 0 && cities.every((city) => city.nationId === nations[0]!.id)
    ? nations[0]!.id
    : null;
}

export type SeasonOutcome = { reason: 'UNIFIED' | 'END_YEAR'; winnerNationId: number | null };
export function seasonOutcome(
  state: WorldState,
  options: { endYear: number | null; settled?: { year: number; month: number } },
): SeasonOutcome | null {
  const winnerNationId = unifiedNation(state);
  if (winnerNationId !== null) return { reason: 'UNIFIED', winnerNationId };
  if (options.endYear !== null && options.settled?.year === options.endYear && options.settled.month === 12)
    return { reason: 'END_YEAR', winnerNationId: null };
  return null;
}
