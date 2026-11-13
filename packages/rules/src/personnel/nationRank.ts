import type { WorldState } from '../model/world';

// core2026 df6c926, app/game-frontend/src/utils/nationFormat.ts. MIT (c) 2025 devsam.
const titles = ['방랑군', '호족', '군벌', '주자사', '주목', '공', '왕', '황제'];
const courtTitles: readonly (readonly string[])[] = [
  ['두목', '부두목'],
  ['영주', '참모'],
  ['군벌', '참모', '비장군', '부참모'],
  ['주자사', '주부', '편장군', '간의대부'],
  ['주목', '태사령', '아문장군', '낭중', '호군', '종사중랑'],
  ['공', '광록대부', '안국장군', '집금오', '파로장군', '소부'],
  ['왕', '광록훈', '좌장군', '상서령', '우장군', '중서령', '전장군', '비서령'],
  ['황제', '승상', '표기장군', '사공', '거기장군', '태위', '위장군', '사도'],
];

export function nationRank(level: number) {
  const offices = courtTitles[level];
  if (!offices) return null;
  return {
    level,
    title: titles[level]!,
    offices: offices.map((title, index) => ({ officerLevel: 12 - index, title })),
  };
}

export const COURT_RANK_FEATURE = 'court-rank-v1';
export const COURT_PROMOTION_FEATURE = 'court-promotion-v1';

// core2026 c81d304, app/game-engine/src/turn/monthlyNationLevelAction.ts (MIT).
const citiesRequired = [0, 1, 2, 5, 8, 11, 16, 21];

export function promoteNationCourts(state: WorldState) {
  const cities = new Map<number, number>();
  for (const city of Object.values(state.cities)) {
    if (city.nationId !== null && city.kind !== 'PASS' && city.level >= 4)
      cities.set(city.nationId, (cities.get(city.nationId) ?? 0) + 1);
  }
  for (const nation of Object.values(state.nations)) {
    const count = cities.get(nation.id) ?? 0;
    const rank = citiesRequired.findLastIndex((required) => count >= required);
    if (rank <= nation.level) continue;
    nation.level = rank;
    nation.gold += rank * 1000;
    nation.rice += rank * 1000;
  }
}

export function courtOfficeTitle(nationLevel: number, officerLevel: number) {
  return courtTitles[nationLevel]?.[12 - officerLevel] ?? null;
}
