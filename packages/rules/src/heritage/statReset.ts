import { z } from 'zod';
import { rngFor } from '@opensamguk/shared';
import { FIVE_STAT_KEYS } from '../general/fiveStats';
import type { RecordedInput, ReplayState } from '../replay';
import type { InitialGeneral } from '../world/bootstrap';
import type { StatRules } from '../world/resources';
import { heritageBonusSchema, readHeritageAllocation } from './allocation';

export const HERITAGE_STAT_RESET_KIND = 'heritage.statReset';
const stat = z.number().int().min(0).max(255);
const statsSchema = z.strictObject({
  leadership: stat,
  strength: stat,
  intel: stat,
  politics: stat.optional(),
  charm: stat.optional(),
});
export const heritageStatResetInput = z.strictObject({
  stats: statsSchema,
  bonus: heritageBonusSchema.optional(),
  expectedCost: z.number().int().min(0).max(1_000),
});
export type HeritageStatResetInput = z.infer<typeof heritageStatResetInput>;

export function purchaseHeritageStatReset(
  general: Pick<InitialGeneral, 'id' | 'heritageStatReset'>,
  rules: StatRules,
  seed: string,
  input: HeritageStatResetInput,
) {
  if (general.heritageStatReset) return null;
  const keys = FIVE_STAT_KEYS.slice(0, rules.count ?? 3);
  const base = keys.map((key) => input.stats[key]);
  if (
    base.some((value) => value === undefined || value < rules.min || value > rules.max) ||
    base.reduce<number>((sum, value) => sum + (value ?? 0), 0) !== rules.total ||
    (keys.length === 3 && (input.stats.politics !== undefined || input.stats.charm !== undefined))
  )
    return null;
  const allocation = readHeritageAllocation(input.bonus, rules, input.stats);
  if (!allocation.ok || (input.bonus && (allocation.cost < 3 || allocation.cost > 5))) return null;
  const cost = input.bonus ? 1_000 : 0;
  if (cost !== input.expectedCost) return null;
  const stats = { ...input.stats };
  if (input.bonus) {
    for (const key of keys) stats[key] = stats[key]! + (allocation.bonus[key] ?? 0);
  } else {
    const rng = rngFor(seed, 'heritage-stat-reset', general.id);
    const points = rng.int(3, 5);
    for (let index = 0; index < points; index++) {
      const candidates = keys.filter((key) => stats[key]! < rules.max);
      if (!candidates.length) break;
      const total = candidates.reduce((sum, key) => sum + Math.max(1, input.stats[key]!), 0);
      let draw = rng.int(1, total);
      const selected = candidates.find((key) => (draw -= Math.max(1, input.stats[key]!)) <= 0)!;
      stats[selected] = stats[selected]! + 1;
    }
  }
  const { leadership, strength, intel, politics, charm } = stats;
  return {
    cost,
    stats: {
      leadership,
      strength,
      intel,
      ...(politics === undefined ? {} : { politics }),
      ...(charm === undefined ? {} : { charm }),
    },
  };
}

export function applyHeritageStatReset(
  replay: ReplayState,
  input: RecordedInput,
  context?: { seed?: string; statRules?: StatRules },
) {
  const actor = input.generalId === null ? undefined : replay.state.generals[input.generalId];
  if (!actor?.userId || actor.removedAt !== undefined || !context?.statRules || context.seed === undefined)
    throw Error('능력치 초기화 장수나 생성 규칙이 없습니다.');
  const purchase = purchaseHeritageStatReset(
    actor,
    context.statRules,
    context.seed,
    heritageStatResetInput.parse(input.payload),
  );
  const result = z.strictObject({ cost: z.number().int().min(0), stats: statsSchema }).parse(input.result);
  if (
    !purchase ||
    purchase.cost !== result.cost ||
    FIVE_STAT_KEYS.some((key) => purchase.stats[key] !== result.stats[key])
  )
    throw Error('능력치 초기화 결과가 다릅니다.');
  const { leadership, strength, intel, politics, charm } = result.stats;
  const updated = {
    ...actor,
    leadership,
    strength,
    intel,
    ...(politics === undefined ? {} : { politics }),
    ...(charm === undefined ? {} : { charm }),
    heritageStatReset: true as const,
  };
  return { ...replay, state: { ...replay.state, generals: { ...replay.state.generals, [actor.id]: updated } } };
}
