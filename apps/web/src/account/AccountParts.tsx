import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { describeFailure, publicFailure } from '../auth/credentials';
import styles from './Account.module.css';

export function AccountFrame({
  title,
  children,
  privateLink = false,
}: {
  title: string;
  children: ReactNode;
  privateLink?: boolean;
}) {
  return (
    <main className={styles.page}>
      {privateLink ? <meta name="referrer" content="no-referrer" /> : null}
      <h1>{title}</h1>
      {children}
      <nav aria-label="계정 이동" className={styles.links}>
        <Link to="/login">로그인</Link>
        <Link to="/lobby">로비</Link>
      </nav>
    </main>
  );
}
export function AccountError({ error }: { error: unknown }) {
  if (publicFailure(error)?.code === 'UNAUTHORIZED') return <p role="alert">로그인이 풀렸습니다. 다시 로그인하세요.</p>;
  const failure = describeFailure(error);
  return <p role="alert">{failure.kind === 'message' ? failure.text : '응답을 받지 못했습니다. 다시 시도하세요.'}</p>;
}
