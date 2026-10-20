import { Link, Outlet, useParams } from '@tanstack/react-router';
import { LogoutButton } from '../auth/LogoutButton';
import { EmptyState } from '../ui/States';
import styles from './GameLayout.module.css';

const NAV = [
  { to: '/w/$worldId', label: '메인', exact: true },
  { to: '/w/$worldId/map', label: '지도' },
  { to: '/w/$worldId/turns', label: '예턴' },
  { to: '/w/$worldId/records', label: '기록' },
] as const;

// 위쪽 띠(월드·연월·다음 턴·메뉴·로그아웃) + 왼쪽 내 장수 요약 + 본문.
// 월드 요약과 장수 요약은 T1-16에서 world.summary·home.get으로 연결한다.
export function GameLayout() {
  const { worldId } = useParams({ from: '/w/$worldId' });
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <span className={styles.world}>월드 {worldId}</span>
        <span className={styles.meta} data-testid="game-date">
          연월 —
        </span>
        <span className={styles.meta} data-testid="next-turn">
          다음 턴까지 —
        </span>
        <nav className={styles.nav} aria-label="게임 메뉴">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              params={{ worldId }}
              activeOptions={{ exact: 'exact' in item }}
              className={styles.navLink}
              activeProps={{ className: `${styles.navLink} ${styles.active}`, 'aria-current': 'page' }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <LogoutButton className={styles.logout} />
      </header>
      <aside className={styles.sidebar} aria-label="내 장수">
        <EmptyState title="내 장수">T1-16에서 연결합니다.</EmptyState>
      </aside>
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
