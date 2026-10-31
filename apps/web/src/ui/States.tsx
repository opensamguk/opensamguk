import { createContext, useContext, type ReactNode } from 'react';
import emptyIcon from '../art/icons/records.png';
import errorIcon from '../art/icons/messages.png';
import styles from './States.module.css';

// 상태 아이콘 (INT-20). 관리자 화면은 그림을 불러오지 않는 계약(AC-M3-08 CH-12)이라 AdminLayout이 끈다.
export const StateIconsContext = createContext(true);

// 빈 목록과 불러오기 실패를 다르게 보여 준다 (v1 원칙).
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  const icons = useContext(StateIconsContext);
  return (
    <div className={styles.empty} data-state="empty">
      {icons ? <img className={`${styles.icon} pixel-art`} src={emptyIcon} alt="" width={32} height={32} /> : null}
      <p className={styles.title}>{title}</p>
      {children ? <div className={styles.body}>{children}</div> : null}
    </div>
  );
}

// 불러오는 중. 빈 상태·오류와 다르게 보이도록 테두리 없이 한 줄로 둔다.
export function LoadingState({ children = '불러오는 중' }: { children?: ReactNode }) {
  return (
    <p className={styles.loading} role="status" aria-live="polite" data-state="loading">
      <span className={styles.dots} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {children}
    </p>
  );
}

export function ErrorState({ title, onRetry }: { title: string; onRetry?: () => void }) {
  const icons = useContext(StateIconsContext);
  return (
    <div className={styles.error} role="alert" data-state="error">
      {icons ? <img className={`${styles.icon} pixel-art`} src={errorIcon} alt="" width={32} height={32} /> : null}
      <p className={styles.title}>{title}</p>
      {onRetry ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          다시 시도
        </button>
      ) : null}
    </div>
  );
}
