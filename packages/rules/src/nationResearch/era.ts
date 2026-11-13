import { BALANCE } from '../balance';

export const RESEARCH_ERA_FEATURE = 'research-era-v1';

export function researchEra(startYear: number, year: number) {
  // core2026 c81d304, che_기술연구.ts (MIT). The threshold advances every five years.
  const maximum = Math.floor(BALANCE.MAX_TECH / 1000);
  const level = Math.min(maximum, Math.max(1, Math.floor((year - startYear) / 5) + 1));
  return { level, nextYear: level < maximum ? startYear + level * 5 : null, threshold: level * 1000 };
}
