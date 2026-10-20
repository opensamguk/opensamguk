import { EmptyState } from '../ui/States';
import styles from './MainPage.module.css';

// 원작 정보량: 한 화면에 장수·도시·국가·예턴 앞 5칸·최근 로그가 다 보이는 격자 (UI 지침 §2).
const PANELS = [
  { key: 'general', title: '내 장수' },
  { key: 'city', title: '현재 도시' },
  { key: 'nation', title: '소속 국가' },
  { key: 'turns', title: '예턴 앞 5칸' },
  { key: 'logs', title: '최근 기록' },
] as const;

export function MainPage() {
  return (
    <section>
      <h1>메인</h1>
      <div className={styles.grid}>
        {PANELS.map((panel) => (
          <section key={panel.key} className={`${styles.panel} ${styles[panel.key]}`} aria-label={panel.title}>
            <h2>{panel.title}</h2>
            <EmptyState title="T1-16에서 연결합니다" />
          </section>
        ))}
      </div>
    </section>
  );
}
