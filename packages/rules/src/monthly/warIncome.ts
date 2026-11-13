import type { WorldState } from '../model/world';
import { nationPhilosophy } from '../personnel/nationPhilosophy';

export const WAR_INCOME_FEATURE = 'war-income-v1';

// core2026 c81d304, war/aftermath.ts and monthlyWarIncomeAction.ts. MIT (c) 2025 devsam.
export function recordWarCasualties(state: WorldState, source: number, destination: number, casualties: number) {
  if (casualties <= 0 || !state.ruleFeatures?.includes(WAR_INCOME_FEATURE)) return;
  const attacker = state.cities[source]!;
  const defender = state.cities[destination]!;
  attacker.warCasualties = Math.min(2_147_483_647, (attacker.warCasualties ?? 0) + Math.trunc(casualties * 0.4));
  defender.warCasualties = Math.min(2_147_483_647, (defender.warCasualties ?? 0) + Math.trunc(casualties * 0.6));
}

export function cityWarIncome(city: { supplied: boolean; warCasualties?: number | null }, multiplier = 1) {
  return city.supplied ? Math.round(((city.warCasualties ?? 0) / 10) * multiplier) : 0;
}

export function settleWarIncome(state: WorldState) {
  for (const city of Object.values(state.cities)) {
    const casualties = city.warCasualties ?? 0;
    if (!casualties) continue;
    const nation = city.nationId === null ? undefined : state.nations[city.nationId];
    if (nation && nation.level > 0 && city.kind !== 'PASS')
      nation.gold += cityWarIncome(city, nationPhilosophy(state, nation.philosophy)?.gold);
    city.population = Math.min(city.populationMax, Math.round(city.population + casualties * 0.2));
    city.warCasualties = 0;
  }
}
