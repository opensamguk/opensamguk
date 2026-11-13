import { combatSpecialty } from '../general/combatSpecialty';
import { personalityEffects } from '../general/personality';
import { BALANCE } from '../balance';
import { FIVE_STAT_KEYS, fiveStatsSchema, type FiveStats } from '../general/fiveStats';
import type { WorldView } from '../model/world';
import { commandConditionStats } from '../general/condition';

type General = WorldView['generals'][number];
type LegacyStat = 'leadership' | 'strength' | 'intel';

export function commandFiveStats(view: WorldView, general: General): FiveStats | null {
  if (!view.ruleFeatures?.includes('five-stats')) return null;
  return fiveStatsSchema.parse(Object.fromEntries(FIVE_STAT_KEYS.map((key) => [key, general[key]])));
}

function commandScores(view: WorldView, general: General): FiveStats | null {
  const stats = commandFiveStats(view, general);
  return stats ? commandConditionStats(view, general, stats) : null;
}

export function domesticStatScore(view: WorldView, general: General, key: string, legacy: LegacyStat): number {
  const stats = commandScores(view, general);
  if (!stats) return general[legacy];
  switch (key) {
    case 'farm':
    case 'commerce':
    case 'wall':
      return stats.politics;
    case 'research':
      return stats.intel;
    case 'goodwill':
      return stats.charm;
    case 'settle':
      return Math.round((stats.politics * 60 + stats.charm * 40) / 100);
    case 'defence':
      return Math.round((stats.leadership * 70 + stats.politics * 30) / 100);
    case 'security':
      return Math.round((stats.strength * 70 + stats.politics * 30) / 100);
    default:
      throw new Error('내정 명령의 능력치 점수가 없습니다.');
  }
}

export function recruitCost(
  view: WorldView,
  general: General,
  amount: number,
  unitCost: number,
  forced: boolean,
  armType?: number,
): number {
  const stats = commandFiveStats(view, general);
  const rate = personalityEffects(view, general.personality)?.recruitPercent;
  const specialty = combatSpecialty(view, general.special);
  const discount = armType !== undefined && specialty?.armType === armType ? 90 : undefined;
  if (rate === undefined && discount === undefined) {
    if (forced) return Math.ceil(amount * unitCost * BALANCE.CONSCRIPT_COST_FACTOR);
    return stats ? Math.ceil((amount * unitCost * (250 - stats.charm)) / 200) : Math.ceil(amount * unitCost);
  }
  const factor = forced ? BALANCE.CONSCRIPT_COST_FACTOR : stats ? (250 - stats.charm) / 200 : 1;
  const cost = (amount * unitCost * factor * (rate ?? 100)) / 100;
  return Math.ceil(discount === undefined ? cost : (cost * discount) / 100);
}

export function drillGain(view: WorldView, general: General, morale: boolean): number {
  const stats = commandScores(view, general);
  if (!stats) return morale ? BALANCE.ATMOS_GAIN : BALANCE.TRAIN_GAIN;
  const score = morale ? Math.round((stats.charm * 60 + stats.leadership * 40) / 100) : stats.leadership;
  return 8 + Math.floor(score / 25);
}

export function affordableRecruits(
  view: WorldView,
  general: General,
  unitCost: number,
  limit: number,
  armType?: number,
): number {
  let low = 0;
  let high = Math.floor(limit);
  while (low < high) {
    const amount = Math.ceil((low + high) / 2);
    if (recruitCost(view, general, amount, unitCost, false, armType) <= general.gold) low = amount;
    else high = amount - 1;
  }
  return low;
}
