// core2026 c81d304, GeneralBasicCard.vue and generalBasicCardProjection.ts. MIT (c) 2025 devsam.
import { withEquipmentBonus } from '../equipment/stats';
import type { WorldView } from '../model/world';
import type { FiveStats } from './fiveStats';

export const GENERAL_CONDITION_FEATURE = 'general-condition-v1';
export const GENERAL_RETIREMENT_AGE = 70;

type CombatStats = Pick<FiveStats, 'leadership' | 'strength' | 'intel'>;

export function generalCondition(general: CombatStats & { injury: number; officerLevel: number }, nationLevel: number) {
  const leadershipBonus = general.officerLevel === 12 ? nationLevel * 2 : general.officerLevel >= 5 ? nationLevel : 0;
  const injured = (value: number) => Math.round((value * (100 - general.injury)) / 100);
  const injuredStats = {
    leadership: injured(general.leadership),
    strength: injured(general.strength),
    intel: injured(general.intel),
  };
  return { injuredStats, leadershipBonus, retirementAge: GENERAL_RETIREMENT_AGE };
}

export function commandConditionStats(view: WorldView, general: WorldView['generals'][number], stats: FiveStats) {
  if (!view.ruleFeatures?.includes(GENERAL_CONDITION_FEATURE)) return withEquipmentBonus(view, general.id, stats);
  const nationLevel = general.nationId === null ? 0 : (view.nations[general.nationId]?.level ?? 0);
  const { injuredStats, leadershipBonus } = generalCondition(general, nationLevel);
  return withEquipmentBonus(view, general.id, {
    ...stats,
    ...injuredStats,
    leadership: injuredStats.leadership + leadershipBonus,
  });
}
