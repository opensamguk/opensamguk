import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { retryUnlessClientError } from '../game/errors';
import { trpcClient, useTRPC, type Trpc } from '../trpc';
import { useAuthority } from './authority';
import type { MessageScope } from './contract';

// 메시지·공지 조회. 키와 옵션은 useTRPC()가 만든 것을 그대로 쓰므로 위쪽 띠 배지·패널 탭·전체 화면이 요청 하나를 나눠 쓴다.
// 모두 권한 값이 정해진 뒤(authority.ts의 ready)에만 서버에 묻는다. enabled가 false여도 캐시의 data는 남으므로
// 화면은 ready 전에는 이 data를 그리지 않는다 (MessagePanel·NationNotice).

export function messageListKey(trpc: Trpc, worldId: string, scope: MessageScope) {
  return trpc.message.list.infiniteQueryKey({ worldId, scope });
}

// 목록 한 쪽. infiniteQueryOptions는 입력에 direction을 늘 덧붙이는데 서버 입력이 strict라 거부한다 (Records.tsx와 같은 이유).
// 그래서 생성된 infinite 키는 그대로 쓰고 호출만 직접 한다. 첫 쪽은 cursor를 빼고, TanStack이 준 signal을 넘겨 취소가 요청까지 닿는다.
export function fetchMessagePage(worldId: string, scope: MessageScope, cursor: string | null, signal: AbortSignal) {
  return trpcClient.message.list.query(cursor === null ? { worldId, scope } : { worldId, scope, cursor }, { signal });
}

export function useUnread(worldId: string) {
  const trpc = useTRPC();
  const { ready } = useAuthority(worldId);
  return useQuery({ ...trpc.message.unread.queryOptions({ worldId }), enabled: ready, retry: retryUnlessClientError });
}

export function useMessageList(worldId: string, scope: MessageScope) {
  const trpc = useTRPC();
  const { ready } = useAuthority(worldId);
  return useInfiniteQuery({
    queryKey: messageListKey(trpc, worldId, scope),
    queryFn: ({ pageParam, signal }) => fetchMessagePage(worldId, scope, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    enabled: ready,
    retry: retryUnlessClientError,
  });
}

export function useRecipients(worldId: string) {
  const trpc = useTRPC();
  const { ready } = useAuthority(worldId);
  return useQuery({
    ...trpc.message.recipients.queryOptions({ worldId }),
    enabled: ready,
    staleTime: 60_000,
    retry: retryUnlessClientError,
  });
}

export function useNationNotice(worldId: string) {
  const trpc = useTRPC();
  const { ready } = useAuthority(worldId);
  return useQuery({
    ...trpc.notice.nation.get.queryOptions({ worldId }),
    enabled: ready,
    retry: retryUnlessClientError,
  });
}

export function useWorldNotices(worldId: string) {
  const trpc = useTRPC();
  const { ready } = useAuthority(worldId);
  return useQuery({
    ...trpc.notice.world.list.queryOptions({ worldId }),
    enabled: ready,
    retry: retryUnlessClientError,
  });
}
