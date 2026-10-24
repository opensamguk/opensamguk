import type { AppRouter } from '@opensamguk/server/router';
import type { QueryKey } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useMemo, useState, type ReactNode } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { useWorldMap, useWorldSummary } from '../game/queries';
import { QueryError } from '../game/QueryState';
import { trpcClient, useTRPC } from '../trpc';
import { LoadingState } from '../ui/States';
import { savedNationSource, type SavedFrame } from './displaySource';
import type { TimelapseFrame, TimelapseMapCity } from './frames';
import { useTimelapsePages, type FetchTimelapsePage } from './pages';
import styles from './Timelapse.module.css';
import { TimelapseView, type DownloadPng } from './TimelapseView';

// 실제 응답 타입. game/types.ts의 Outputs는 export되지 않아 같은 방식으로 여기서 꺼낸다.
type FramesOutput = inferRouterOutputs<AppRouter>['timelapse']['frames'];
type ServerFrame = FramesOutput['items'][number];

// tRPC의 infiniteQueryOptions는 입력에 direction을 덧붙이는데 서버 입력은 strict라 거부한다.
// 그래서 기록 조회(main/Records.tsx)처럼 직접 부르고 signal을 넘겨 패널이 사라지면 요청이 끊기게 한다.
const fetchFrames: FetchTimelapsePage<ServerFrame> = (input, { signal }) =>
  trpcClient.timelapse.frames.query(input, { signal });

// 지도에서는 도시 이름·좌표·연결만 쓴다. world.map의 도시(MapCity)도 이 모양에 들어간다.
// cities에 지금 소유(nationId)가 함께 오지만 쓰지 않고, 맨 위 nations(지금 국가 행)만 받을 자리가 없다.
export interface TimelapseMap {
  data: { cities: readonly TimelapseMapCity[] } | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

// 기록 화면의 영토 재생 탭. 조회를 잇기만 하고 상태 고르기와 그리기는 TimelapseScreen이 한다.
// 끝난 월드면 위에 공유 링크 복사 버튼을 둔다 (T4-37 3.2). 상태는 같은 world.summary 캐시를 읽는다.
export function TimelapsePanel({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const map = useWorldMap(worldId);
  const summary = useWorldSummary(worldId);
  const queryKey = useMemo(() => [...trpc.timelapse.frames.queryKey({ worldId }), 'pages'] as const, [trpc, worldId]);
  return (
    <>
      <ShareLinkButton worldId={worldId} status={summary.data?.status} />
      <TimelapseScreen
        worldId={worldId}
        fetchPage={fetchFrames}
        queryKey={queryKey}
        map={map}
        {...(summary.data ? { worldName: summary.data.name } : {})}
      />
    </>
  );
}

// 끝난(ENDED) 월드에서만 그린다. 주소를 클립보드에 넣을 뿐이고 서버에 공유를 등록하지 않는다.
// 클립보드를 쓸 수 없으면 주소를 글로 보여 직접 복사하게 한다.
export function ShareLinkButton({
  worldId,
  status,
  origin = window.location.origin,
  writeText = (text: string) => navigator.clipboard.writeText(text),
}: {
  worldId: string;
  status: string | undefined;
  origin?: string;
  writeText?: (text: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  if (status !== 'ENDED') return null;
  const url = `${origin}/share/timelapse/${worldId}`;
  const copy = async () => {
    try {
      await writeText(url);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <p className={styles.status} data-testid="timelapse-share">
      <button type="button" className={styles.button} onClick={() => void copy()}>
        공유 링크 복사
      </button>
      {copied === 'done' ? <span role="status">공유 링크를 복사했습니다. 로그인 없이 볼 수 있습니다.</span> : null}
      {copied === 'failed' ? (
        <span role="status">
          복사하지 못했습니다. 이 주소를 직접 복사하세요. <span data-testid="timelapse-share-url">{url}</span>
        </span>
      ) : null}
    </p>
  );
}

// 첫 페이지·지도 상태를 고르고 받은 프레임을 그 프레임의 저장값 출처로 그린다.
// 프레임 타입은 SavedFrame이어야 해서 응답에서 nations가 빠지면 타입 검사가 깨진다. currentNations는 읽지 않는다.
// 공유 화면은 첫 페이지 오류 문구(firstPageError)만 바꿔 같은 상태 고르기를 쓴다.
export function TimelapseScreen<F extends TimelapseFrame & SavedFrame>({
  worldId,
  fetchPage,
  queryKey,
  map,
  retry = retryUnlessClientError,
  worldName,
  firstPageError,
  download,
}: {
  worldId: string;
  fetchPage: FetchTimelapsePage<F>;
  queryKey: QueryKey;
  map: TimelapseMap;
  retry?: typeof retryUnlessClientError | false;
  worldName?: string;
  firstPageError?: (error: unknown, retry: () => void) => ReactNode;
  download?: DownloadPng;
}) {
  const { query, frames, contractError, hasMore } = useTimelapsePages(worldId, fetchPage, queryKey, retry);
  const source = useMemo(() => savedNationSource(frames), [frames]);
  if (query.data === undefined) {
    if (query.isError && !query.isFetching) {
      const again = () => void query.refetch();
      return firstPageError ? (
        firstPageError(query.error, again)
      ) : (
        <QueryError error={query.error} notFound="월드를 찾을 수 없습니다" onRetry={again} />
      );
    }
    return <LoadingState />;
  }
  if (map.data === undefined) {
    if (map.isError)
      return <QueryError error={map.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void map.refetch()} />;
    return <LoadingState />;
  }
  return (
    <TimelapseView
      frames={frames}
      map={map.data.cities}
      source={source}
      hasMore={hasMore}
      nextError={query.isFetchNextPageError}
      onRetryNext={() => void query.fetchNextPage()}
      contractError={contractError}
      {...(worldName === undefined ? {} : { worldName })}
      {...(download === undefined ? {} : { download })}
    />
  );
}
