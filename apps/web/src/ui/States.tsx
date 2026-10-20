import type { ReactNode } from 'react';
import styles from './States.module.css';

// 빈 목록과 불러오기 실패를 다르게 보여 준다 (v1 원칙).
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={styles.empty} data-state="empty">
      <p className={styles.title}>{title}</p>
      {children ? <div className={styles.body}>{children}</div> : null}
    </div>
  );
}

export function ErrorState({ title, onRetry }: { title: string; onRetry?: () => void }) {
  return (
    <div className={styles.error} role="alert" data-state="error">
      <p className={styles.title}>{title}</p>
      {onRetry ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          다시 시도
        </button>
      ) : null}
    </div>
  );
}
