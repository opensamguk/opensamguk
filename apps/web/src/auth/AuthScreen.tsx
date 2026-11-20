import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import { useId, type ReactNode } from 'react';
import styles from './AuthPage.module.css';

// 계정 화면 공용 틀 (INT-29 화면 개편, 사용자 승인 시안 「좋아 이대로」). 표지 그림을 화면 가득 깔고,
// 위 가운데에 로고, 그 아래 키트 창 하나에 장식 제목과 양식을 둔다. 곁 칸(공개 지도)과 아래 띠(중원 정세)는 있으면 단다.
const KEYART = 'apps/web/src/art/keyart.png';
const LOGO = 'apps/web/src/art/ui/kit-b/logo-opensamguk.webp';
const keyartUrl = hasPublicImage(KEYART) ? publicImageUrl(KEYART) : null;
const logoUrl = hasPublicImage(LOGO) ? publicImageUrl(LOGO) : null;

export function AuthScreen({
  title,
  children,
  aside,
  footer,
}: {
  title: string;
  children: ReactNode;
  /** 창 오른쪽(좁은 화면은 아래)에 붙는 판. 로그인의 공개 지도 탭. */
  aside?: ReactNode;
  /** 화면 맨 아래 띠. 로그인의 중원 정세. */
  footer?: ReactNode;
}) {
  const titleId = useId();
  return (
    <main className={styles.screen} style={keyartUrl ? { backgroundImage: `url("${keyartUrl}")` } : undefined}>
      <div className={styles.brand}>
        {logoUrl ? (
          <img className={styles.logo} src={logoUrl} alt="오픈삼국" width={520} height={260} />
        ) : (
          <p className={styles.logoText}>오픈삼국</p>
        )}
      </div>
      <div className={aside ? `${styles.stage} ${styles.withAside}` : styles.stage}>
        <section className={`kit-window ${styles.window}`} aria-labelledby={titleId}>
          <h1 id={titleId} className={`kit-title ${styles.title}`}>
            {title}
          </h1>
          {children}
        </section>
        {aside ? <div className={`kit-card ${styles.aside}`}>{aside}</div> : null}
      </div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </main>
  );
}
