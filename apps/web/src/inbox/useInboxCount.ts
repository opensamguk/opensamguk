import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import type { TreatyListPage } from '../diplomacy/contract';
import { personnelKeys, type AssignmentOfferView } from '../personnel/contract';
import { useTRPC } from '../trpc';
import { countInbox, type CampaignBoard } from './count';

// 메뉴의 제안함 수 (INT-20). 캐시에 이미 있는 발령·휘하·외교 조회만 읽고 새로 묻지 않는다.
// 그래서 아직 열지 않은 화면의 제안은 그 화면이나 제안함을 연 뒤에 수에 들어간다.
export function useInboxCount(worldId: string): number {
  const client = useQueryClient();
  const trpc = useTRPC();
  const subscribe = useCallback((onChange: () => void) => client.getQueryCache().subscribe(onChange), [client]);
  const snapshot = () =>
    countInbox({
      offers: client.getQueryData<AssignmentOfferView[]>(personnelKeys.offers(worldId)),
      board: client.getQueryData<CampaignBoard>(trpc.campaign.get.queryKey({ worldId })),
      treaties: client.getQueryData<InfiniteData<TreatyListPage>>(trpc.treaty.list.infiniteQueryKey({ worldId })),
    });
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
