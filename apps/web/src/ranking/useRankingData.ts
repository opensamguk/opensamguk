import type { GeneralRanking, NationRanking, RankingSearch } from './rankingView';

export type RankingData =
  | { state: 'waiting' } // 순위 API(T2-22)가 아직 없다
  | { state: 'loading' }
  | { state: 'error'; retry: () => void }
  | { state: 'ready'; tab: 'generals'; ranking: GeneralRanking }
  | { state: 'ready'; tab: 'nations'; ranking: NationRanking };

// 순위 자료를 가져오는 자리는 여기 하나다. T2-22가 합쳐지면 아래를 이렇게 바꾼다.
//   tab === 'generals' → useQuery(trpc.ranking.generals.queryOptions({ worldId, by }))
//   tab === 'nations'  → useQuery(trpc.ranking.nations.queryOptions({ worldId, by }))
export function useRankingData(worldId: string, search: RankingSearch): RankingData {
  void worldId;
  void search;
  return { state: 'waiting' };
}
