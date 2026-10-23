import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { retryUnlessClientError } from '../game/errors';
import { api, messageKeys, noticeKeys, type MessageScope } from './contract';

// 같은 키를 쓰므로 위쪽 띠 배지·패널 탭·전체 화면이 요청 하나를 나눠 쓴다.
export function useUnread(worldId: string, enabled = true) {
  return useQuery({
    queryKey: messageKeys.unread(worldId),
    queryFn: () => api.message.unread.query({ worldId }),
    enabled,
    retry: retryUnlessClientError,
  });
}

export function useMessageList(worldId: string, scope: MessageScope) {
  return useInfiniteQuery({
    queryKey: messageKeys.list(worldId, scope),
    queryFn: ({ pageParam }) =>
      api.message.list.query(pageParam === null ? { worldId, scope } : { worldId, scope, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    retry: retryUnlessClientError,
  });
}

export function useRecipients(worldId: string) {
  return useQuery({
    queryKey: messageKeys.recipients(worldId),
    queryFn: () => api.message.recipients.query({ worldId }),
    staleTime: 60_000,
    retry: retryUnlessClientError,
  });
}

export function useNationNotice(worldId: string, enabled = true) {
  return useQuery({
    queryKey: noticeKeys.nation(worldId),
    queryFn: () => api.notice.nation.get.query({ worldId }),
    enabled,
    retry: retryUnlessClientError,
  });
}

export function useWorldNotices(worldId: string) {
  return useQuery({
    queryKey: noticeKeys.world(worldId),
    queryFn: () => api.notice.world.list.query({ worldId }),
    retry: retryUnlessClientError,
  });
}
