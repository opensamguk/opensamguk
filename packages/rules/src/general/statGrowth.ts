import { z } from 'zod';
import { DOMESTIC_SPECS } from '../commands/domestic/investment';
import type { WorldState } from '../model/world';

export const STAT_GROWTH_FEATURE = 'stat-growth-v1';
export const MILITARY_STAT_GROWTH_FEATURE = 'military-stat-growth-v1';
export const STAT_UPGRADE_LIMIT = 30;
const maximumStat = 255;
const counter = z
  .number()
  .int()
  .min(0)
  .max(STAT_UPGRADE_LIMIT - 1);
const counters = z.strictObject({ leadership: counter, strength: counter, intel: counter });
export type StatExperience = z.infer<typeof counters>;
export const emptyStatExperience: Readonly<StatExperience> = Object.freeze({ leadership: 0, strength: 0, intel: 0 });

export function storedStatExperience(value: unknown) {
  return value == null ? {} : { statExperience: counters.parse(value) };
}

// core2026 c81d304, reservedTurnHandler.ts and general action definitions. MIT (c) 2025 devsam.
const militaryExperience: Record<string, { stat: keyof StatExperience; amount: number }> = Object.fromEntries([
  ...['return', 'conscript', 'train', 'morale', 'donate', 'troop_gather', 'incite'].map(
    (key) => [key, { stat: 'leadership', amount: 1 }] as const,
  ),
  ['convert_proficiency', { stat: 'leadership', amount: 2 }],
  ['sabotage', { stat: 'strength', amount: 1 }],
  ['fire_attack', { stat: 'intel', amount: 1 }],
]);

export function growCommandStat(state: WorldState, generalId: number, command: string) {
  if (!state.ruleFeatures?.includes(STAT_GROWTH_FEATURE)) return;
  const domestic = DOMESTIC_SPECS.find(({ key }) => key === command);
  const gain = domestic
    ? { stat: domestic.stat, amount: 1 }
    : state.ruleFeatures.includes(MILITARY_STAT_GROWTH_FEATURE) && Object.hasOwn(militaryExperience, command)
      ? militaryExperience[command]
      : undefined;
  if (!gain) return;
  const { stat, amount } = gain;
  const general = state.generals[generalId]!;
  const experience = { ...(general.statExperience ?? emptyStatExperience) };
  experience[stat] += amount;
  if (experience[stat] >= STAT_UPGRADE_LIMIT) {
    experience[stat] -= STAT_UPGRADE_LIMIT;
    const cap = state.ruleFeatures.includes('five-stats') ? 100 : maximumStat;
    if (general[stat] < cap) general[stat]++;
  }
  general.statExperience = experience;
}
