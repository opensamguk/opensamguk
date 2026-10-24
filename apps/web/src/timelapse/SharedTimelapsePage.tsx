import { Link } from '@tanstack/react-router';
import { useMemo, useState, type ReactNode } from 'react';
import { errorCode, isNotFound } from '../game/errors';
import { trpcClient, useTRPC } from '../trpc';
import { EmptyState, ErrorState } from '../ui/States';
import type { FetchTimelapsePage } from './pages';
import { toSharedHead, toSharedPage, type SharedFrame, type SharedHead } from './sharedSource';
import styles from './Timelapse.module.css';
import { TimelapseScreen, type TimelapseMap } from './TimelapsePanel';

// 종료 월드 공유 화면 (docs/plans/T4-37.md 3.1·3.2). 로그인 가드 밖이고 위쪽 띠·메뉴가 없다.
// 공개 조회 timelapse.publicFrames(T4-91)만 쓴다. 30개씩 오래된 달부터 받고 지도는 첫 페이지에서만 읽는다.
// 이어 받기·계약 위반·기록 없는 달·캐시 정책은 로그인 재생과 같은 TimelapseScreen이 맡는다.

// 거부는 서버 오류 코드로만 가른다. data.reason은 늘 null이다 (T4-91 2.3).
// 로그인 링크는 일반 주소 링크다. 로그인 화면이 다른 화면 묶음이라 라우터 상태를 이어 갈 것이 없다.
export function sharedErrorView(error: unknown, retry: () => void): ReactNode {
  if (errorCode(error) === 'FORBIDDEN')
    return (
      <EmptyState title="종료된 월드만 로그인 없이 볼 수 있습니다.">
        <a href="/login">로그인</a>
      </EmptyState>
    );
  if (isNotFound(error)) return <EmptyState title="월드를 찾을 수 없습니다." />;
  return <ErrorState title="불러오지 못했습니다" onRetry={retry} />;
}

export function SharedTimelapsePage({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  // 첫 페이지의 월드 이름·종료 연월·지도. 첫 페이지를 받을 때마다 새로 정한다(캐시는 패널이 사라지면 지워진다).
  const [head, setHead] = useState<SharedHead | null>(null);
  const fetchPage = useMemo<FetchTimelapsePage<SharedFrame>>(
    () =>
      async (input, { signal }) => {
        const page = await trpcClient.timelapse.publicFrames.query(input, { signal });
        if (!('cursor' in input)) setHead(toSharedHead(page));
        return toSharedPage(page);
      },
    [],
  );
  const queryKey = useMemo(
    () => [...trpc.timelapse.publicFrames.queryKey({ worldId }), 'pages'] as const,
    [trpc, worldId],
  );
  const map: TimelapseMap = {
    data: head ? { cities: head.map } : undefined,
    isError: false,
    error: null,
    refetch: () => undefined,
  };
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 var(--space-2)' }}>
        {head ? `${head.world.name} · 영토 재생` : '영토 재생'}
      </h1>
      <p className={styles.note}>
        <span>로그인 없이 보는 종료 월드 기록입니다.</span>
        {head ? <span className="num">{`${head.world.endedYear}년 ${head.world.endedMonth}월 종료`}</span> : null}
        <Link to="/lobby">로비</Link>
      </p>
      <section aria-label="공유 영토 재생" style={{ marginTop: 'var(--space-3)' }}>
        <TimelapseScreen
          worldId={worldId}
          fetchPage={fetchPage}
          queryKey={queryKey}
          map={map}
          firstPageError={sharedErrorView}
          {...(head ? { worldName: head.world.name } : {})}
        />
      </section>
    </main>
  );
}
