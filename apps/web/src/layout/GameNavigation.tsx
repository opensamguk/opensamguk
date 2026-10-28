import { Link, useLocation } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { OFFICER_MIN_LEVEL } from '../operations/contract';
import styles from './GameNavigation.module.css';

// 구조 참고: opensamguk-v1 bc053629의 GameFrame.tsx·nav31.ts (MIT).
// Copyright (c) 2026 빼뽀네 (peppone-choi) and OpenSamguk contributors.
// 현재 React 주소와 메인 지도·30칸 예약을 유지하고 연결된 화면만 안내한다.
const NAV = [
  { to: '/w/$worldId', label: '메인', exact: true },
  { to: '/w/$worldId/turns', label: '예턴' },
  { to: '/w/$worldId/map', label: '지도' },
  { to: '/w/$worldId/nation/personnel', label: '국가' },
  { to: '/w/$worldId/diplomacy', label: '외교' },
  { to: '/w/$worldId/operations', label: '작전' },
  { to: '/w/$worldId/records', label: '기록' },
  { to: '/w/$worldId/ranking', label: '순위' },
  { to: '/w/$worldId/simulator', label: '전투 시뮬레이터' },
] as const;

export function GameNavigation({
  worldId,
  campaignEnabled,
  officerLevel,
}: {
  worldId: string;
  campaignEnabled: boolean;
  officerLevel: number;
}) {
  const { pathname } = useLocation();
  const more = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const close = (restoreFocus = false) => {
    if (!more.current?.open) return;
    more.current.open = false;
    if (restoreFocus) summary.current?.focus();
  };
  useEffect(() => {
    if (more.current) more.current.open = false;
  }, [pathname]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && more.current?.open) {
        more.current.open = false;
        summary.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !more.current?.contains(event.target) && more.current)
        more.current.open = false;
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', outside);
    };
  }, []);

  const links = (
    <>
      {NAV.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          params={{ worldId }}
          activeOptions={{ exact: 'exact' in item, includeSearch: false }}
          className={styles.link}
          activeProps={{ className: `${styles.link} ${styles.active}`, 'aria-current': 'page' }}
          onClick={() => close()}
        >
          {item.label}
        </Link>
      ))}
      {campaignEnabled ? (
        pathname.replace(/\/$/, '') === `/w/${worldId}` ? (
          <a className={styles.link} href="#campaign-title" onClick={() => close()}>
            휘하·부곡
          </a>
        ) : (
          <Link
            to="/w/$worldId"
            params={{ worldId }}
            hash="campaign-title"
            className={styles.link}
            onClick={() => close()}
          >
            휘하·부곡
          </Link>
        )
      ) : null}
      {officerLevel >= OFFICER_MIN_LEVEL ? (
        <Link to="/w/$worldId/nation/inspection" params={{ worldId }} className={styles.link} onClick={() => close()}>
          감찰
        </Link>
      ) : null}
      <Link to="/help/$doc" params={{ doc: 'index' }} className={styles.link} onClick={() => close()}>
        도움말
      </Link>
    </>
  );
  return (
    <div className={styles.navigation}>
      <nav className={styles.rail} aria-label="게임 메뉴">
        {links}
      </nav>
      <nav className={styles.mobile} aria-label="게임 메뉴">
        {NAV.filter((item) => ['메인', '예턴', '기록'].includes(item.label)).map((item) => (
          <Link
            key={item.to}
            to={item.to}
            params={{ worldId }}
            activeOptions={{ exact: 'exact' in item, includeSearch: false }}
            className={styles.link}
            activeProps={{ className: `${styles.link} ${styles.active}`, 'aria-current': 'page' }}
            onClick={() => close()}
          >
            {item.label}
          </Link>
        ))}
        <details ref={more} className={styles.more}>
          <summary ref={summary} className={styles.link}>
            전체
          </summary>
          <div className={styles.menu}>
            <button type="button" className={styles.close} onClick={() => close(true)}>
              메뉴 닫기
            </button>
            {links}
          </div>
        </details>
      </nav>
    </div>
  );
}
