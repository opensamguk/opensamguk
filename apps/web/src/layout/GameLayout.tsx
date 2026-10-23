import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LogoutButton } from '../auth/LogoutButton';
import { formatRemaining, useTurnCountdown } from '../game/countdown';
import { errorCode, isNotFound } from '../game/errors';
import { useHome, useWorldSummary } from '../game/queries';
import type { WorldSummary } from '../game/types';
import { liveRefresh, topbarStatus } from '../game/worldWatch';
import { OFFICER_MIN_LEVEL } from '../operations/contract';
import { MessageButton, MessageDrawer, RealtimeStatusText } from '../messages/MessageDock';
import { NationNoticePopup } from '../messages/NationNotice';
import { useWorldEvents } from '../realtime/useWorldEvents';
import { useTRPC } from '../trpc';
import styles from './GameLayout.module.css';

// 핵심 조작은 메인 한 화면에서 한다 (소유자 UI 정정 2026-10-21). 메뉴의 다른 주소는 넓게 보는 보조 화면이다.
const NAV = [
  { to: '/w/$worldId', label: '메인', exact: true },
  { to: '/w/$worldId/turns', label: '예턴' },
  { to: '/w/$worldId/records', label: '기록' },
  { to: '/w/$worldId/ranking', label: '순위' },
  { to: '/w/$worldId/simulator', label: '전투 시뮬레이터' },
  { to: '/w/$worldId/diplomacy', label: '외교' },
  { to: '/w/$worldId/operations', label: '작전' },
] as const;

// 위쪽 띠에는 월드 이름·현재 연월·다음 턴까지 남은 시간·메뉴·로그아웃. 본문은 화면 폭을 다 쓴다.
export function GameLayout() {
  const { worldId } = useParams({ from: '/w/$worldId' });
  const summary = useWorldSummary(worldId, true);
  const home = useHome(worldId);
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // 월드 SSE(T2-10). 알림마다 해당 query만 다시 받고, 이어질 때마다(ready) 화면 전체를 한 번 다시 받는다.
  const realtime = useWorldEvents(worldId);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const messageButton = useRef<HTMLButtonElement>(null);
  const closeMessages = useCallback(() => {
    setMessagesOpen(false);
    messageButton.current?.focus();
  }, []);

  // 0초가 되면 내 장수·월드 요약·기록을 다시 받는다. 같은 쿼리를 쓰는 메인 칸도 함께 바뀐다.
  // SSE가 이어져 있으면 turn.result·monthly.done이 그 일을 하므로 끊긴 동안에만 쓴다 (T1-16 임시 방식의 대체, T2-10).
  const realtimeOpen = realtime.status === 'open';
  const refresh = useCallback(() => {
    if (realtimeOpen) return;
    void queryClient.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
    void queryClient.invalidateQueries({ queryKey: trpc.world.summary.queryKey({ worldId }) });
    void queryClient.invalidateQueries({ queryKey: trpc.records.pathKey() });
  }, [queryClient, realtimeOpen, trpc, worldId]);
  const nextTurnAt = home.data?.nextTurnAt ?? null;
  const countdown = useTurnCountdown(nextTurnAt, refresh);
  const noGeneral = home.isError && errorCode(home.error) === 'NOT_FOUND';

  // world.summary를 새로 받을 때마다 상태·모드 전환과 가속 중 갱신을 판단한다 (worldWatch.ts).
  // 끝난 판은 위 주기 조회가 멈추므로 여기서도 더 묻지 않는다.
  const watched = useRef<(Pick<WorldSummary, 'status' | 'clockMode'> & { worldId: string }) | undefined>(undefined);
  const data = summary.data;
  useEffect(() => {
    if (!data) return;
    const next = { worldId, status: data.status, clockMode: data.clockMode };
    const previous = watched.current?.worldId === worldId ? watched.current : undefined;
    const homeKey = trpc.home.get.queryKey({ worldId });
    const homeNotFound = errorCode(queryClient.getQueryState(homeKey)?.error) === 'NOT_FOUND';
    const plan = liveRefresh(previous, next, homeNotFound);
    watched.current = next;
    if (plan.home) void queryClient.invalidateQueries({ queryKey: homeKey });
    if (plan.records) void queryClient.invalidateQueries({ queryKey: trpc.records.pathKey() });
    if (plan.board)
      for (const queryKey of [trpc.world.map.queryKey({ worldId }), trpc.city.pathKey(), trpc.nation.pathKey()])
        void queryClient.invalidateQueries({ queryKey });
  }, [data, summary.dataUpdatedAt, queryClient, trpc, worldId]);

  const worldName =
    summary.data?.name ?? (summary.isError && isNotFound(summary.error) ? '월드를 찾을 수 없습니다' : '월드');
  // 끝난 판은 결과에 저장한 종료 연월을 쓴다. 서버의 gameDate도 같은 값이다.
  const shown = data?.result ?? data?.gameDate;
  const date = shown ? `${shown.year}년 ${shown.month}월` : '연월 —';
  const nextText = topbarStatus(data, noGeneral, countdown, formatRemaining);

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Link to="/lobby" className={styles.navLink}>
          로비
        </Link>
        <span className={styles.world}>{worldName}</span>
        <span className={styles.meta} data-testid="game-date">
          {date}
        </span>
        <span
          className={styles.meta}
          data-testid="next-turn"
          data-next-turn-at={nextTurnAt ?? undefined}
          data-clock-mode={data?.clockMode}
          aria-live="off"
        >
          {nextText}
        </span>
        <RealtimeStatusText status={realtime.status} />
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
          {/* 감찰은 직책자만 받는다(T2-12). 메뉴를 보일지만 여기서 정하고 권한은 서버가 다시 본다. */}
          {(home.data?.general.officerLevel ?? 0) >= OFFICER_MIN_LEVEL ? (
            <Link
              to="/w/$worldId/nation/inspection"
              params={{ worldId }}
              className={styles.navLink}
              activeProps={{ className: `${styles.navLink} ${styles.active}`, 'aria-current': 'page' }}
            >
              감찰
            </Link>
          ) : null}
          <Link to="/help/$doc" params={{ doc: 'index' }} className={styles.navLink}>
            도움말
          </Link>
        </nav>
        <MessageButton
          ref={messageButton}
          worldId={worldId}
          open={messagesOpen}
          onToggle={() => (messagesOpen ? closeMessages() : setMessagesOpen(true))}
        />
        <Link to="/settings/notifications" className={styles.account}>
          알림 설정
        </Link>
        <LogoutButton className={styles.logout} />
      </header>
      <main className={styles.content}>
        <Outlet />
      </main>
      {messagesOpen ? <MessageDrawer worldId={worldId} onClose={closeMessages} /> : null}
      <NationNoticePopup worldId={worldId} />
    </div>
  );
}
