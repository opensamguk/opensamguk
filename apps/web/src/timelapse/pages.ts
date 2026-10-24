import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { joinPages, type TimelapseFrame, type TimelapsePage } from './frames';

export type TimelapseInput = { worldId: string } | { worldId: string; cursor: string };
export type FetchTimelapsePage<F extends TimelapseFrame = TimelapseFrame> = (
  input: TimelapseInput,
  options: { signal: AbortSignal },
) => Promise<TimelapsePage<F>>;

// 이 쿼리에만 거는 캐시 정책. 보는 동안은 다시 받지 않고 패널이 사라지면 진행 중 요청을 끊고 캐시를 지운다.
// 그래서 다시 열면 첫 페이지부터 받아 그 사이 정산된 달이 나온다. 다른 지도·기록 캐시는 건드리지 않는다.
// 끊기는 것은 queryFn이 signal을 읽었을 때뿐이다 (@tanstack/query-core Query.removeObserver).
export const TIMELAPSE_CACHE = {
  staleTime: Infinity,
  gcTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

// 첫 페이지를 받은 뒤에는 이 쿼리를 비활성으로 둔다. SSE ready는 연결·재연결마다 invalidateQueries()로 화면의 모든
// 쿼리를 무효화하는데, 그 기본 refetchType 'active'는 enabled가 false인 관찰자만 가진 쿼리를 다시 받지 않는다.
// 이어 받기(fetchNextPage)와 첫 페이지 오류 뒤 다시 시도(refetch)는 enabled와 관계없이 돈다 (docs/plans/T4-36.md 2.2).
const untilFirstPage = (query: { state: { data: unknown } }) => query.state.data === undefined;

// 오래된 달부터 30개씩 받고 nextCursor가 null이 될 때까지 한 번에 한 요청씩 이어 받는다.
// 계약 위반(순서·cursor)이 보이면 이어 받기를 멈춘다. 프레임 타입 인자를 그대로 넘겨 응답의 칸을 잃지 않는다.
export function useTimelapsePages<F extends TimelapseFrame>(
  worldId: string,
  fetchPage: FetchTimelapsePage<F>,
  queryKey: QueryKey,
  retry: typeof retryUnlessClientError | false = retryUnlessClientError,
) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      fetchPage(pageParam === undefined ? { worldId } : { worldId, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: TimelapsePage<F>) => last.nextCursor ?? undefined,
    retry,
    enabled: untilFirstPage,
    ...TIMELAPSE_CACHE,
  });
  const pages = query.data?.pages;
  const joined = useMemo(() => (pages ? joinPages(pages) : null), [pages]);
  const contractError = joined && !joined.ok ? joined.error : null;
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = query;
  useEffect(() => {
    if (joined === null || contractError !== null) return;
    if (hasNextPage && !isFetching && !isFetchNextPageError) void fetchNextPage();
  }, [joined, contractError, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);
  return { query, frames: joined?.frames ?? [], contractError, hasMore: hasNextPage && contractError === null };
}
