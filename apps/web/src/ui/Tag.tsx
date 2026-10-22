import type { ReactNode } from 'react';
import styles from './Tag.module.css';

export type TagTone = 'danger' | 'warning' | 'info' | 'muted' | 'accent';

// 짧은 상태 표시. 색만으로 뜻을 전하지 않도록 항상 글자를 함께 쓴다 (NFR-08).
export function Tag({ tone, children, title }: { tone: TagTone; children: ReactNode; title?: string }) {
  return (
    <span className={`${styles.tag} ${styles[tone]}`} data-tone={tone} title={title}>
      {children}
    </span>
  );
}
