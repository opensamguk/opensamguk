// 순위 화면의 자료 모양과 순수 함수. 모양은 docs/plans/T2-22.md의 API 계약을 따른다.
// T2-22가 합쳐지면 이 타입 대신 AppRouter에서 꺼낸 타입을 쓴다.

export type RankingTab = 'generals' | 'nations';
export type GeneralSortKey = 'dedication' | 'experience' | 'merit';
export type NationSortKey = 'cities' | 'generals' | 'power';

export interface RankingAt {
  year: number;
  month: number;
}

export interface RankedGeneral {
  rank: number;
  generalId: number;
  name: string;
  nation: { id: number; name: string; color: string } | null;
  dedication: number;
  experience: number;
  merit: number;
}

export interface RankedNation {
  rank: number;
  nationId: number;
  name: string;
  color: string;
  cities: number;
  generals: number;
  power: number;
}

export interface GeneralRanking {
  top: RankedGeneral[];
  me: RankedGeneral | null;
  at: RankingAt | null;
}

export interface NationRanking {
  items: RankedNation[];
  at: RankingAt | null;
}

export const GENERAL_COLUMNS: ReadonlyArray<{ key: GeneralSortKey; label: string }> = [
  { key: 'dedication', label: '공헌' },
  { key: 'experience', label: '경험' },
  { key: 'merit', label: '전공' },
];

export const NATION_COLUMNS: ReadonlyArray<{ key: NationSortKey; label: string }> = [
  { key: 'cities', label: '도시' },
  { key: 'generals', label: '장수' },
  { key: 'power', label: '국력' },
];

export type RankingSearch = { tab: 'generals'; by: GeneralSortKey } | { tab: 'nations'; by: NationSortKey };

// 주소의 tab·by가 틀리면 탭마다 첫 기준으로 돌린다. 장수 탭에 국가 기준(by=cities)이 오는 경우도 같다.
export function parseRankingSearch(search: Record<string, unknown>): RankingSearch {
  if (search.tab === 'nations') {
    const by = NATION_COLUMNS.find((c) => c.key === search.by)?.key ?? 'cities';
    return { tab: 'nations', by };
  }
  const by = GENERAL_COLUMNS.find((c) => c.key === search.by)?.key ?? 'dedication';
  return { tab: 'generals', by };
}

// 탭을 바꾸면 그 탭의 첫 기준부터 본다.
export function defaultSearch(tab: RankingTab): RankingSearch {
  return parseRankingSearch({ tab });
}

// 1~3위 배지 색. v1 명장 순위(web/game/app/game/rankings/best-generals/page.tsx:51-53)의 gold·jade·muted를 따른다.
export function rankTone(rank: number): 'gold' | 'jade' | 'muted' | null {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'jade';
  if (rank === 3) return 'muted';
  return null;
}

export function formatAt(at: RankingAt | null): string {
  return at === null ? '아직 월간 정산 전이라 순위가 없습니다' : `${at.year}년 ${at.month}월 정산 기준`;
}
