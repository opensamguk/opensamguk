import { useMemo } from 'react';
import { useWorldMap } from '../game/queries';
import { QueryError } from '../game/QueryState';
import { trpcClient, useTRPC } from '../trpc';
import { LoadingState } from '../ui/States';
import { storedNationSource } from './displaySource';
import { useTimelapsePages, type FetchTimelapsePage } from './pages';
import { TimelapseView } from './TimelapseView';

// 실제 응답이 지역 타입(frames.ts)에 할당되지 않으면 여기서 타입 검사가 깨진다.
// signal을 넘겨야 패널이 사라질 때 진행 중 요청이 끊긴다 (pages.ts TIMELAPSE_CACHE).
const fetchFrames = ((input, { signal }) =>
  trpcClient.timelapse.frames.query(input, { signal })) satisfies FetchTimelapsePage;

// 기록 화면의 영토 재생 탭. 프레임은 timelapse.frames, 좌표는 world.map에서 받는다.
// 월드가 바뀌면 부모가 key로 다시 만들어 재생 위치와 받은 프레임을 버린다.
export function TimelapsePanel({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const map = useWorldMap(worldId);
  // records 아래가 아니라서 위쪽 띠의 기록 무효화에 걸리지 않는다.
  const queryKey = useMemo(() => [...trpc.timelapse.frames.queryKey({ worldId }), 'pages'], [trpc, worldId]);
  const { query, frames, contractError, hasMore } = useTimelapsePages(worldId, fetchFrames, queryKey);
  const source = useMemo(() => storedNationSource(frames), [frames]);

  if (map.isError) {
    return <QueryError error={map.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void map.refetch()} />;
  }
  if (query.data === undefined) {
    if (query.isError) {
      return <QueryError error={query.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void query.refetch()} />;
    }
    return <LoadingState />;
  }
  if (!map.data) return <LoadingState />;
  return (
    <TimelapseView
      frames={frames}
      map={map.data.cities}
      source={source}
      hasMore={hasMore}
      nextError={query.isFetchNextPageError}
      onRetryNext={() => void query.fetchNextPage()}
      contractError={contractError}
    />
  );
}
