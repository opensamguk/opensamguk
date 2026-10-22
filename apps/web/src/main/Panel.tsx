import type { ReactNode } from 'react';
import styles from './Panel.module.css';

// 메인 작업 화면의 한 칸. 원작 PanelCard처럼 머리글 한 줄 + 본문.
export function Panel({
  title,
  area,
  actions,
  children,
  flush,
}: {
  title: string;
  area?: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className={styles.panel} aria-label={title} data-main-area={area}>
      <header className={styles.head}>
        <h2 className={styles.title}>{title}</h2>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      <div className={flush ? `${styles.body} ${styles.flush}` : styles.body}>{children}</div>
    </section>
  );
}

// 머리글·값 두 칸씩 늘어놓는 정보 격자 (원작 카드의 head/body 칸).
export function InfoGrid({
  items,
}: {
  items: ReadonlyArray<{ label: string; value: ReactNode; title?: string | undefined }>;
}) {
  return (
    <dl className={styles.grid}>
      {items.map((item) => (
        <div key={item.label} className={styles.cell} title={item.title}>
          <dt>{item.label}</dt>
          <dd className="num">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
