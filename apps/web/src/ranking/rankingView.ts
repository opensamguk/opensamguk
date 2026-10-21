// 순위 화면의 자료 모양과 순수 함수. 자료 모양은 순위 API(apps/server의 ranking 라우터)에서 꺼낸다.
import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

type RankingInputs = inferRouterInputs<AppRouter>['ranking'];
type RankingOutputs = inferRouterOutputs<AppRouter>['ranking'];

export type RankingTab = 'generals' | 'nations';
export type GeneralSortKey = RankingInputs['generals']['by'];
export type NationSortKey = RankingInputs['nations']['by'];

// 응답에는 화면에 쓰지 않는 항목(at.tick, 장수의 wins·captures·value, 국가의 value)도 있다. 보이지 않게 둔다.
export type GeneralRanking = RankingOutputs['generals'];
export type NationRanking = RankingOutputs['nations'];
export type RankedGeneral = GeneralRanking['top'][number];
export type RankedNation = NationRanking['items'][number];
export type RankingAt = NonNullable<GeneralRanking['at']>;

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
