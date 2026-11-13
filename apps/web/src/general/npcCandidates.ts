import { FIVE_STATS, STATS } from './createForm';

// NPC 무장 맡기 후보 줄의 능력치 (INT-26, 원작 빙의 후보 카드의 통솔·무력·지력).
// entry.roles는 5능력치 월드에서만 politics·charm을 준다. 키가 없으면 3능력치 월드로 보고 세 칸만 쓴다.
export type CandidateStats = {
  generalId: number;
  leadership: number;
  strength: number;
  intel: number;
  politics?: number;
  charm?: number;
};

export type StatCell = { key: string; label: string; value: number };

export function candidateStats(general: CandidateStats): StatCell[] {
  const five = general.politics !== undefined && general.charm !== undefined;
  return (five ? FIVE_STATS : STATS).map(({ key, label }) => ({ key, label, value: general[key] ?? 0 }));
}

export function statTotal(general: CandidateStats): number {
  return candidateStats(general).reduce((sum, cell) => sum + cell.value, 0);
}

// 능력치 합이 큰 순. 같으면 장수 번호 순으로 둬 다시 불러와도 줄이 흔들리지 않는다.
export function sortByStatTotal<T extends CandidateStats>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => statTotal(b) - statTotal(a) || a.generalId - b.generalId);
}
