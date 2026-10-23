import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { useCallback } from 'react';
import { LogoutButton } from '../auth/LogoutButton';
import { formatRemaining, useTurnCountdown } from '../game/countdown';
import { errorCode, isNotFound } from '../game/errors';
import { useHome, useWorldSummary } from '../game/queries';
import { useTRPC } from '../trpc';
import styles from './GameLayout.module.css';

// 핵심 조작은 메인 한 화면에서 한다 (소유자 UI 정정 2026-10-21). 메뉴의 다른 주소는 넓게 보는 보조 화면이다.
const NAV = [
  { to: '/w/$worldId', label: '메인', exact: true },
  { to: '/w/$worldId/turns', label: '예턴' },
  { to: '/w/$worldId/records', label: '기록' },
  { to: '/w/$worldId/ranking', label: '순위' },
  { to: '/w/$worldId/simulator', label: '전투 시뮬레이터' },
] as const;

const STATUS_TEXT: Record<string, string> = { PREOPEN: '개시 전', PAUSED: '일시 정지', ENDED: '종료' };

// 위쪽 띠에는 월드 이름·현재 연월·다음 턴까지 남은 시간·메뉴·로그아웃. 본문은 화면 폭을 다 쓴다.
export function GameLayout() {
  const { worldId } = useParams({ from: '/w/$worldId' });
  const summary = useWorldSummary(worldId);
  const home = useHome(worldId);
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // 0초가 되면 내 장수·월드 요약·기록을 다시 받는다. 같은 쿼리를 쓰는 메인 칸도 함께 바뀐다.
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
    void queryClient.invalidateQueries({ queryKey: trpc.world.summary.queryKey({ worldId }) });
    void queryClient.invalidateQueries({ queryKey: trpc.records.pathKey() });
  }, [queryClient, trpc, worldId]);
  const nextTurnAt = home.data?.nextTurnAt ?? null;
  const countdown = useTurnCountdown(nextTurnAt, refresh);

  const worldName =
    summary.data?.name ?? (summary.isError && isNotFound(summary.error) ? '월드를 찾을 수 없습니다' : '월드');
  const date = summary.data ? `${summary.data.gameDate.year}년 ${summary.data.gameDate.month}월` : '연월 —';
  const status = summary.data?.status;
  let nextText = '다음 턴까지 —';
  if (status && status !== 'RUNNING') nextText = STATUS_TEXT[status] ?? status;
  else if (home.isError && errorCode(home.error) === 'NOT_FOUND') nextText = '내 장수 없음';
  else if (countdown.seconds !== null)
    nextText = countdown.waiting ? '턴 처리 중' : `다음 턴까지 ${formatRemaining(countdown.seconds)}`;

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <span className={styles.world}>{worldName}</span>
        <span className={styles.meta} data-testid="game-date">
          {date}
        </span>
        <span
          className={styles.meta}
          data-testid="next-turn"
          data-next-turn-at={nextTurnAt ?? undefined}
          aria-live="off"
        >
          {nextText}
        </span>
        <nav className={styles.nav} aria-label="게임 메뉴">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              params={{ worldId }}
              activeOptions={{ exact: 'exact' in item, includeSearch: false }}
              className={styles.navLink}
              activeProps={{ className: `${styles.navLink} ${styles.active}`, 'aria-current': 'page' }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <Link to="/settings/notifications" className={styles.account}>
          알림 설정
        </Link>
        <LogoutButton className={styles.logout} />
      </header>
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
