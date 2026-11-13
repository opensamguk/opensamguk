// core2026 c81d304, che_물자원조.ts and che_거병.ts. MIT (c) 2025 devsam.
export const DIPLOMATIC_COOLDOWN_FEATURE = 'diplomatic-cooldown-v1';

export function diplomaticAidMonths(nation: { diplomaticAidUntilMonth?: number | null }, month: number) {
  return Math.max(0, (nation.diplomaticAidUntilMonth ?? 0) - month);
}
