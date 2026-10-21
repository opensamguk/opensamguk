import { keepPreviousData, skipToken, useQuery } from '@tanstack/react-query';
import { useTRPC } from '../trpc';
import type { GeneralRanking, NationRanking, RankingSearch } from './rankingView';

export type RankingData =
  | { state: 'loading' }
  | { state: 'error'; retry: () => void }
  | { state: 'ready'; tab: 'generals'; ranking: GeneralRanking }
  | { state: 'ready'; tab: 'nations'; ranking: NationRanking };

// 순위 자료를 가져오는 자리는 여기 하나다. 보고 있는 탭만 부른다.
// 기준을 바꾸는 동안에는 이전 순서를 그대로 두어 표가 깜빡이지 않게 한다.
export function useRankingData(worldId: string, search: RankingSearch): RankingData {
  const trpc = useTRPC();
  const generals = useQuery(
    trpc.ranking.generals.queryOptions(search.tab === 'generals' ? { worldId, by: search.by } : skipToken, {
      placeholderData: keepPreviousData,
    }),
  );
  const nations = useQuery(
    trpc.ranking.nations.queryOptions(search.tab === 'nations' ? { worldId, by: search.by } : skipToken, {
      placeholderData: keepPreviousData,
    }),
  );
  const query = search.tab === 'generals' ? generals : nations;
  if (query.isError) return { state: 'error', retry: () => void query.refetch() };
  if (search.tab === 'generals' && generals.data) return { state: 'ready', tab: 'generals', ranking: generals.data };
  if (search.tab === 'nations' && nations.data) return { state: 'ready', tab: 'nations', ranking: nations.data };
  return { state: 'loading' };
}
