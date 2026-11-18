import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import type { TreatyListPage } from '../diplomacy/contract';
import { personnelKeys, type AssignmentOfferView } from '../personnel/contract';
import { useTRPC } from '../trpc';
import { countInbox, type CampaignBoard } from './count';

// 발령·휘하·외교는 기존 캐시를 읽고, 상신은 권한자가 받은 열린 제안을 조회한다.
export function useInboxCount(worldId: string): number {
  const client = useQueryClient();
  const trpc = useTRPC();
  const proposals = useQuery(
    trpc.proposals.list.queryOptions(
      { worldId, box: 'received', status: 'PENDING' },
      { retry: false, refetchInterval: 30_000 },
    ),
  );
  const subscribe = useCallback((onChange: () => void) => client.getQueryCache().subscribe(onChange), [client]);
  const snapshot = () =>
    countInbox({
      offers: client.getQueryData<AssignmentOfferView[]>(personnelKeys.offers(worldId)),
      board: client.getQueryData<CampaignBoard>(trpc.campaign.get.queryKey({ worldId })),
      treaties: client.getQueryData<InfiniteData<TreatyListPage>>(trpc.treaty.list.infiniteQueryKey({ worldId })),
    });
  return useSyncExternalStore(subscribe, snapshot, snapshot) + (proposals.data?.length ?? 0);
}
