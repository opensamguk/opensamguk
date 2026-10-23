import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useTRPC } from '../trpc';
import { retryUnlessClientError } from './errors';
import { summaryPollMs } from './worldWatch';

// 게임 화면은 모두 /w/$worldId 아래에 있다.
export function useWorldId(): string {
  return useParams({ from: '/w/$worldId' }).worldId;
}

// 같은 쿼리 키를 쓰므로 위쪽 띠·왼쪽 요약·메인이 요청 하나를 나눠 쓴다.
// 주기 조회는 위쪽 띠(watch) 한 곳에서만 켠다. 관찰자마다 켜면 같은 주기에 요청이 겹친다.
export function useWorldSummary(worldId: string, watch = false) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.world.summary.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: watch ? (query) => summaryPollMs(query.state.data, query.state.error) : false,
  });
}

// 끝난 판이면 예턴·장수 화면의 주기 조회도 멈춘다. 같은 world.summary 캐시를 읽기만 한다.
export function useWorldEnded(worldId: string): boolean {
  return useWorldSummary(worldId).data?.status === 'ENDED';
}

export function useHome(worldId: string) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.home.get.queryOptions({ worldId }), retry: retryUnlessClientError });
}

export function useWorldMap(worldId: string) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.world.map.queryOptions({ worldId }), retry: retryUnlessClientError, staleTime: 30_000 });
}
