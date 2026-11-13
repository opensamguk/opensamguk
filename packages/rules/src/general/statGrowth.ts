import { z } from 'zod';
import { DOMESTIC_SPECS } from '../commands/domestic/investment';
import type { WorldState } from '../model/world';

export const STAT_GROWTH_FEATURE = 'stat-growth-v1';
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

// core2026 c81d304, reservedTurnHandler.ts and the domestic command definitions. MIT (c) 2025 devsam.
export function growDomesticStat(state: WorldState, generalId: number, command: string) {
  if (!state.ruleFeatures?.includes(STAT_GROWTH_FEATURE)) return;
  const stat = DOMESTIC_SPECS.find(({ key }) => key === command)?.stat;
  if (!stat) return;
  const general = state.generals[generalId]!;
  const experience = { ...(general.statExperience ?? emptyStatExperience) };
  experience[stat]++;
  if (experience[stat] >= STAT_UPGRADE_LIMIT) {
    experience[stat] -= STAT_UPGRADE_LIMIT;
    if (general[stat] < maximumStat) general[stat]++;
  }
  general.statExperience = experience;
}
