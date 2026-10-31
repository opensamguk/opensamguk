import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, type MouseEvent } from 'react';
import { OFFICER_MIN_LEVEL } from '../operations/contract';
import mainIcon from '../art/icons/main.png';
import turnsIcon from '../art/icons/turns.png';
import mapIcon from '../art/icons/map.png';
import nationIcon from '../art/icons/nation.png';
import diplomacyIcon from '../art/icons/diplomacy.png';
import operationsIcon from '../art/icons/operations.png';
import recordsIcon from '../art/icons/records.png';
import rankingIcon from '../art/icons/ranking.png';
import battleIcon from '../art/icons/battle.png';
import personnelIcon from '../art/icons/personnel.png';
import helpIcon from '../art/icons/help.png';
import messagesIcon from '../art/icons/messages.png';
import { useInboxCount } from '../inbox/useInboxCount';
import styles from './GameNavigation.module.css';

// 구조 참고: opensamguk-v1 bc053629의 GameFrame.tsx·nav31.ts (MIT).
// Copyright (c) 2026 빼뽀네 (peppone-choi) and OpenSamguk contributors.
// 현재 React 주소와 메인 지도·30칸 예약을 유지하고 연결된 화면만 안내한다.
// 아이콘은 Codex 생성 도트 그림이다 (apps/web/src/art/sources.json, D-041).
const NAV = [
  { to: '/w/$worldId', label: '군략도', icon: mainIcon, exact: true },
  { to: '/w/$worldId', label: '예턴', icon: turnsIcon, area: 'main-commands' },
  { to: '/w/$worldId/map', label: '지도', icon: mapIcon },
  { to: '/w/$worldId/nation/personnel', label: '국가', icon: nationIcon },
  { to: '/w/$worldId/diplomacy', label: '외교', icon: diplomacyIcon },
  { to: '/w/$worldId/inbox', label: '제안함', icon: messagesIcon },
  { to: '/w/$worldId/operations', label: '작전', icon: operationsIcon },
  { to: '/w/$worldId/records', label: '기록', icon: recordsIcon },
  { to: '/w/$worldId/ranking', label: '순위', icon: rankingIcon },
  { to: '/w/$worldId/simulator', label: '전투 시뮬레이터', icon: battleIcon },
] as const;

const Icon = ({ src }: { src: string }) => <img src={src} alt="" width={32} height={32} className={styles.icon} />;

export function GameNavigation({
  worldId,
  campaignEnabled,
  officerLevel,
}: {
  worldId: string;
  campaignEnabled: boolean;
  officerLevel: number;
}) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const inbox = useInboxCount(worldId);
  const city = Number(search.city);
  const citySearch = Number.isInteger(city) && city > 0 && city <= 2_147_483_647 ? { city } : {};
  const navSearch = (to: string) => (to === '/w/$worldId' || to === '/w/$worldId/records' ? citySearch : {});
  const more = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const close = (restoreFocus = false) => {
    if (!more.current?.open) return;
    more.current.open = false;
    if (restoreFocus) summary.current?.focus();
  };
  const openTurns = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    close();
    if (pathname.replace(/\/$/, '') === `/w/${worldId}`) {
      const heading = document.getElementById('main-commands');
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
    } else void navigate({ to: '/w/$worldId', params: { worldId }, search: citySearch, hash: 'main-commands' });
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

  const navigationLink = (item: (typeof NAV)[number]) =>
    'area' in item ? (
      <a
        key={item.label}
        href={`/w/${encodeURIComponent(worldId)}${'city' in citySearch ? `?city=${citySearch.city}` : ''}#${item.area}`}
        className={styles.link}
        onClick={openTurns}
      >
        <Icon src={item.icon} />
        {item.label}
      </a>
    ) : (
      <Link
        key={item.label}
        to={item.to}
        params={{ worldId }}
        search={navSearch(item.to)}
        activeOptions={{ exact: 'exact' in item, includeSearch: false }}
        className={styles.link}
        activeProps={{ className: `${styles.link} ${styles.active}`, 'aria-current': 'page' }}
        onClick={() => close()}
      >
        <Icon src={item.icon} />
        {item.label}
        {item.label === '제안함' && inbox > 0 ? (
          <span className={styles.badge}>
            <span className="num">{inbox}</span>
            <span className={styles.hidden}>건 대기</span>
          </span>
        ) : null}
      </Link>
    );
  const links = (
    <>
      {NAV.map(navigationLink)}
      {campaignEnabled ? (
        pathname.replace(/\/$/, '') === `/w/${worldId}` ? (
          <a className={styles.link} href="#campaign-title" onClick={() => close()}>
            <Icon src={personnelIcon} />
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
            <Icon src={personnelIcon} />
            휘하·부곡
          </Link>
        )
      ) : null}
      {officerLevel >= OFFICER_MIN_LEVEL ? (
        <Link to="/w/$worldId/nation/inspection" params={{ worldId }} className={styles.link} onClick={() => close()}>
          <Icon src={nationIcon} />
          감찰
        </Link>
      ) : null}
      <Link to="/help/$doc" params={{ doc: 'index' }} className={styles.link} onClick={() => close()}>
        <Icon src={helpIcon} />
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
        {NAV.filter((item) => ['군략도', '예턴', '기록'].includes(item.label)).map(navigationLink)}
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
