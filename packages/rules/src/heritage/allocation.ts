import { z } from 'zod';
import { FIVE_STAT_KEYS } from '../general/fiveStats';
import type { StatRules } from '../world/resources';
import { HERITAGE_ERRORS, HERITAGE_V1 } from './constants';

export type HeritageStat = (typeof FIVE_STAT_KEYS)[number];
const bonus = z.number().int().min(1).max(HERITAGE_V1.perStat).optional();
export const heritageBonusSchema = z
  .strictObject({
    leadership: bonus,
    strength: bonus,
    intel: bonus,
    politics: bonus,
    charm: bonus,
  })
  .refine((value) => {
    const cost = Object.values(value).reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
    return cost >= 1 && cost <= HERITAGE_V1.perGeneral;
  });
export type HeritageBonus = z.infer<typeof heritageBonusSchema>;

export function readHeritageAllocation(
  value: unknown,
  rules: Pick<StatRules, 'count' | 'max'>,
  base: Partial<Record<HeritageStat, number>>,
): { ok: true; bonus: HeritageBonus; cost: number } | { ok: false; code: 'BAD_HERITAGE'; message: string } {
  if (value === undefined) return { ok: true, bonus: {}, cost: 0 };
  const invalid = { ok: false as const, code: 'BAD_HERITAGE' as const, message: HERITAGE_ERRORS.BAD_HERITAGE };
  const parsed = heritageBonusSchema.safeParse(value);
  if (!parsed.success) return invalid;
  const normalized: HeritageBonus = {};
  let cost = 0;
  for (const key of FIVE_STAT_KEYS) {
    const amount = parsed.data[key];
    if (amount === undefined) continue;
    if (rules.count !== 5 && (key === 'politics' || key === 'charm')) return invalid;
    const stat = base[key];
    if (stat === undefined || !Number.isSafeInteger(stat) || stat + amount > rules.max) return invalid;
    normalized[key] = amount;
    cost += amount;
  }
  return { ok: true, bonus: normalized, cost };
}
