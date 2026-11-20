import { z } from 'zod';

export const FIVE_STAT_KEYS = ['leadership', 'strength', 'intel', 'politics', 'charm'] as const;
const stat = z.number().int().min(0).max(100);
export const fiveStatsSchema = z.strictObject({
  leadership: stat,
  strength: stat,
  intel: stat,
  politics: stat,
  charm: stat,
});
export type FiveStats = z.infer<typeof fiveStatsSchema>;
// 장수의 나머지 필드는 건드리지 않고 같은 정수·0~100 계약으로 다섯 값을 복사한다.
// 정상 턴마다 Object.fromEntries와 Zod 출력 객체를 거듭 만들지 않는다.
export function readGeneralFiveStats(general: object): FiveStats {
  const row = general as Record<string, unknown>;
  const stats = {
    leadership: row.leadership,
    strength: row.strength,
    intel: row.intel,
    politics: row.politics,
    charm: row.charm,
  };
  for (const key of FIVE_STAT_KEYS) {
    const value = stats[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100)
      return fiveStatsSchema.parse(stats);
  }
  return stats as FiveStats;
}
export const FIVE_STAT_RULES = { count: 5 as const, total: 275, min: 15, max: 90 };
export const FIVE_NPC_STAT_RULES = { count: 5 as const, total: 250, min: 10, max: 85 };

// 구형 상태에는 두 필드 자체가 없어야 한다. 누락·null을 새 능력치로 추정하지 않는다.
export function assertGeneralStatProfile(general: object, five: boolean): void {
  if (five) {
    readGeneralFiveStats(general);
  } else if (Object.hasOwn(general, 'politics') || Object.hasOwn(general, 'charm')) {
    throw new Error('기존 장수에 새 능력치를 넣을 수 없습니다.');
  }
}

export function checkStatProfile(initial: {
  statRules: { count?: number | undefined; total: number; min: number; max: number };

  generals: readonly object[];
}): void {
  if (initial.statRules.count === undefined || initial.statRules.count === 3) {
    for (const general of initial.generals) assertGeneralStatProfile(general, false);
    return;
  }
  if (initial.statRules.count !== 5) throw new Error('능력치 규칙과 기능 판이 다릅니다.');
  if (initial.statRules.total !== 275 || initial.statRules.min !== 15 || initial.statRules.max !== 90)
    throw new Error('5능력치 생성 규칙을 확인하세요.');
  for (const general of initial.generals) assertGeneralStatProfile(general, true);
}

// DB의 nullable 열은 세 능력 월드의 규칙 상태에 포함하지 않는다.
export function storedGeneralStats<T extends object>(row: T, five: boolean) {
  const { politics, charm, ...base } = row as T & { politics?: number | null; charm?: number | null };
  if (!five && (politics != null || charm != null)) throw new Error('기존 월드에 새 능력치가 저장됐습니다.');
  const general = { ...base, ...(five ? { politics: politics!, charm: charm! } : {}) };
  assertGeneralStatProfile(general, five);
  return general;
}
export function generalStats(general: {
  leadership: number;
  strength: number;
  intel: number;
  politics?: number;
  charm?: number;
}) {
  return Object.hasOwn(general, 'politics') || Object.hasOwn(general, 'charm')
    ? readGeneralFiveStats(general)
    : { leadership: general.leadership, strength: general.strength, intel: general.intel };
}
export function pledgeChance(general: { charm?: number; leadership: number }): number {
  return 25 + Math.floor((general.charm ?? general.leadership) / 2);
}
