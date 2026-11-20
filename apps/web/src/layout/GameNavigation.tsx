import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { OFFICER_MIN_LEVEL } from '../operations/contract';
// 메뉴 아이콘은 키트 B 둥근 단추 아이콘(icon-nav-*)이다. 승인 목록에 없으면 단추 바탕만 보인다.
const navIcon = (name: string) => {
  const source = `apps/web/src/art/ui/kit-b/icon-nav-${name}.webp`;
  return hasPublicImage(source) ? publicImageUrl(source) : undefined;
};
const mainIcon = navIcon('main');
const turnsIcon = navIcon('turns');
const mapIcon = navIcon('map');
const nationIcon = navIcon('nation');
const diplomacyIcon = navIcon('diplomacy');
const inboxIcon = navIcon('inbox');
const operationsIcon = navIcon('operations');
const recordsIcon = navIcon('records');
const rankingIcon = navIcon('ranking');
const simulatorIcon = navIcon('simulator');
const retinueIcon = navIcon('account');
const helpIcon = navIcon('help');
const menuIcon = navIcon('settings');
import { useInboxCount } from '../inbox/useInboxCount';
import styles from './GameNavigation.module.css';

// 구조 참고: opensamguk-v1 bc053629의 GameFrame.tsx·nav31.ts (MIT).
// Copyright (c) 2026 빼뽀네 (peppone-choi) and OpenSamguk contributors.
// 현재 React 주소와 메인 지도·30칸 예약을 유지하고 연결된 화면만 안내한다.
// 단추는 키트 A 둥근 단추 위에 키트 B 아이콘을 얹고 이름을 아래에 적는다 (INT-29 화면 개편 초안).
const NAV = [
  { to: '/w/$worldId', label: '군략도', icon: mainIcon, exact: true },
  { to: '/w/$worldId', label: '예턴', icon: turnsIcon, area: 'main-commands' },
  { to: '/w/$worldId/map', label: '지도', icon: mapIcon },
  { to: '/w/$worldId/nation/personnel', label: '국가', icon: nationIcon },
  { to: '/w/$worldId/diplomacy', label: '외교', icon: diplomacyIcon },
  { to: '/w/$worldId/inbox', label: '제안함', icon: inboxIcon },
  { to: '/w/$worldId/operations', label: '작전', icon: operationsIcon },
  { to: '/w/$worldId/records', label: '기록', icon: recordsIcon },
  { to: '/w/$worldId/ranking', label: '순위', icon: rankingIcon },
  { to: '/w/$worldId/simulator', label: '전투 시뮬레이터', icon: simulatorIcon },
] as const;

// 둥근 단추 그림 안의 아이콘. 이름 글자가 링크의 접근 이름이므로 그림은 비워 읽힌다.
const Icon = ({ src }: { src: string | undefined }) => (
  <span className={styles.round} aria-hidden="true">
    {src ? <img src={src} alt="" width={24} height={24} className={styles.icon} /> : null}
  </span>
);

export function GameNavigation({
  worldId,
  officerLevel,
  accountLinks,
}: {
  worldId: string;
  officerLevel: number;
  // 좁은 화면에서만 넘긴다. 위 띠에서 빠진 관리자·내 계정·알림 설정을 `전체` 메뉴 끝에 둔다.
  accountLinks?: ((className: string | undefined) => ReactNode) | undefined;
}) {
  const { pathname, search, hash } = useLocation();
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
        aria-current={pathname.replace(/\/$/, '') === `/w/${worldId}` && hash === item.area ? 'location' : undefined}
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
      <Link to="/w/$worldId/campaign" params={{ worldId }} className={styles.link} onClick={() => close()}>
        <Icon src={retinueIcon} />
        휘하·부곡
      </Link>
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
  // 좁은 메인은 메인 하단 막대(지도·예턴·현황·기록·메시지·메뉴, INT-25)가 이 막대를 대신한다. 다른 화면은 그대로다.
  const onMain = pathname.replace(/\/$/, '') === `/w/${worldId}`;
  return (
    <div className={styles.navigation} data-main-page={onMain ? 'true' : undefined}>
      <nav className={styles.rail} aria-label="게임 메뉴">
        {links}
      </nav>
      <nav className={`${styles.mobile} kit-bar-bottom`} aria-label="게임 메뉴">
        {NAV.filter((item) => ['군략도', '예턴', '기록'].includes(item.label)).map(navigationLink)}
        <details ref={more} className={styles.more}>
          <summary ref={summary} className={styles.link}>
            <Icon src={menuIcon} />
            전체
          </summary>
          <div className={`${styles.menu} kit-tooltip`}>
            <button
              type="button"
              className={`${styles.close} kit-button`}
              data-kind="secondary"
              onClick={() => close(true)}
            >
              메뉴 닫기
            </button>
            {links}
            {accountLinks ? (
              // 링크로 주소가 바뀌면 위 pathname 효과가 메뉴를 닫는다.
              <div className={styles.accountLinks} role="group" aria-label="계정">
                {accountLinks(styles.link)}
              </div>
            ) : null}
          </div>
        </details>
      </nav>
    </div>
  );
}
