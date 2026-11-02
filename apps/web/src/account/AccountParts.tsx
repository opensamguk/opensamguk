import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { describeFailure, publicFailure } from '../auth/credentials';
import styles from './Account.module.css';

export function AccountFrame({
  title,
  children,
  privateLink = false,
  plaque,
  icon,
  panels = false,
}: {
  title: string;
  children: ReactNode;
  privateLink?: boolean;
  /** 첩 머리의 꾸밈 현판 글자. 제목이 아니다. */
  plaque?: string | undefined;
  /** 현판 위 64px 도트 아이콘 주소. 꾸밈이라 대체 글을 비운다. */
  icon?: string | undefined;
  /** 참이면 자식을 첩 한 장에 담지 않는다. 자식이 각자 첩(.panel)을 그린다. */
  panels?: boolean;
}) {
  const nav = (
    <nav aria-label="계정 이동" className={styles.links}>
      <Link to="/login">로그인</Link>
      <Link to="/lobby">로비</Link>
    </nav>
  );
  return (
    <main className={styles.page}>
      {privateLink ? <meta name="referrer" content="no-referrer" /> : null}
      {/* 먹 띠 아래 한지 첩 (INT-20). */}
      <header className={styles.band}>
        <span className={styles.brand}>오픈삼국</span>
        <h1>{title}</h1>
      </header>
      {panels ? (
        <div className={styles.panels}>
          {children}
          <div className={styles.panelNav}>{nav}</div>
        </div>
      ) : (
        <div className={styles.leaf}>
          {icon ? <img className={styles.icon} src={icon} alt="" width={64} height={64} /> : null}
          {plaque ? <span className={styles.plaque}>{plaque}</span> : null}
          {children}
          {nav}
        </div>
      )}
    </main>
  );
}
export function AccountError({ error }: { error: unknown }) {
  if (publicFailure(error)?.code === 'UNAUTHORIZED') return <p role="alert">로그인이 풀렸습니다. 다시 로그인하세요.</p>;
  const failure = describeFailure(error);
  return <p role="alert">{failure.kind === 'message' ? failure.text : '응답을 받지 못했습니다. 다시 시도하세요.'}</p>;
}
