import { useState } from 'react';
import fallbackUrl from './fallback.svg';
import styles from './Portrait.module.css';
import { portraitUrl, PORTRAIT_VARIANTS, type PortraitVariant } from './portraitUrl';

interface PortraitProps {
  id: number | null | undefined;
  name: string;
  variant?: PortraitVariant;
  className?: string;
}

// 초상 ID가 없거나 범위 밖이면, 또는 파일을 못 불러오면 실루엣에 이름 첫 글자를 얹어 보여 준다 (FR-IMG-03).
export function Portrait({ id, name, variant = 'portrait', className }: PortraitProps) {
  const src = portraitUrl(id, variant);
  // 실패한 주소를 기억한다. 주소가 바뀌면(다른 장수, 다른 base) 다시 시도한다.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const fallback = src === null || failedSrc === src;
  const { width, height } = PORTRAIT_VARIANTS[variant];

  return (
    <span
      className={[styles.frame, styles[variant], className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-state={fallback ? 'fallback' : 'image'}
    >
      {fallback ? (
        <>
          <img className={styles.image} src={fallbackUrl} alt={name} width={width} height={height} />
          <span className={styles.initial} aria-hidden="true">
            {Array.from(name)[0] ?? ''}
          </span>
        </>
      ) : (
        <img
          className={styles.image}
          src={src}
          alt={name}
          width={width}
          height={height}
          loading="lazy"
          onError={() => setFailedSrc(src)}
        />
      )}
    </span>
  );
}
