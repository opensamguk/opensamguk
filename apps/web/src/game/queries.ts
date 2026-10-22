import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useTRPC } from '../trpc';
import { retryUnlessClientError } from './errors';

// 게임 화면은 모두 /w/$worldId 아래에 있다.
export function useWorldId(): string {
  return useParams({ from: '/w/$worldId' }).worldId;
}

// 같은 쿼리 키를 쓰므로 위쪽 띠·왼쪽 요약·메인이 요청 하나를 나눠 쓴다.
export function useWorldSummary(worldId: string) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.world.summary.queryOptions({ worldId }), retry: retryUnlessClientError });
}

export function useHome(worldId: string) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.home.get.queryOptions({ worldId }), retry: retryUnlessClientError });
}

export function useWorldMap(worldId: string) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.world.map.queryOptions({ worldId }), retry: retryUnlessClientError, staleTime: 30_000 });
}
