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

// 불러오는 중. 빈 상태·오류와 다르게 보이도록 테두리 없이 한 줄로 둔다.
export function LoadingState({ children = '불러오는 중' }: { children?: ReactNode }) {
  return (
    <p className={styles.loading} role="status" aria-live="polite" data-state="loading">
      {children}
    </p>
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
