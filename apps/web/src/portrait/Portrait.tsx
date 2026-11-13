import { publicImageUrl } from '@opensamguk/shared/public-images';
import { useState, type CSSProperties } from 'react';
const fallbackUrl = publicImageUrl('apps/web/src/portrait/fallback.svg');
import styles from './Portrait.module.css';
import { portraitUrl, PORTRAIT_VARIANTS, type PortraitVariant } from './portraitUrl';

interface PortraitProps {
  id: number | null | undefined;
  name: string;
  variant?: PortraitVariant;
  // icon만 원형으로 쓸 수 있다 (D-085). 메인은 portrait, 목록·요약은 원형 icon, 표는 thumb.
  shape?: 'square' | 'round';
  // 줄여 그릴 폭(px). 높이는 변형 비율로 정한다. 예: icon 32 → 32×32, thumb 20 → 20×28 (28px 표 행).
  size?: number | undefined;
  // 옆에 이름 글자가 있으면 true. 그림의 alt를 비워 화면 낭독기가 이름을 두 번 읽지 않게 한다.
  decorative?: boolean | undefined;
  className?: string | undefined;
}

// 초상 ID가 없거나 범위 밖이면, 또는 파일을 못 불러오면 실루엣에 이름 첫 글자를 얹어 보여 준다 (FR-IMG-03).
export function Portrait({
  id,
  name,
  variant = 'portrait',
  shape = 'square',
  size,
  decorative = false,
  className,
}: PortraitProps) {
  const src = portraitUrl(id, variant);
  // 실패한 주소를 기억한다. 주소가 바뀌면(다른 장수, 다른 base) 다시 시도한다.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const fallback = src === null || failedSrc === src;
  const { width, height } = PORTRAIT_VARIANTS[variant];
  const alt = decorative ? '' : name;
  const initial = Array.from(name)[0] ?? '';
  const sized: CSSProperties | undefined =
    size === undefined
      ? undefined
      : ({
          width: size,
          height: Math.round((size * height) / width),
          '--portrait-size': `${size}px`,
        } as CSSProperties);

  return (
    <span
      className={[
        styles.frame,
        styles[variant],
        shape === 'round' && variant === 'icon' ? styles.round : null,
        sized ? styles.sized : null,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-variant={variant}
      data-state={fallback ? 'fallback' : 'image'}
      style={sized}
    >
      {fallback ? (
        <>
          <img className={styles.image} src={fallbackUrl} alt={alt} width={width} height={height} />
          {decorative ? (
            // 이름 글자가 옆에 있으므로 첫 글자는 CSS로만 그린다. 행·칸의 글자(textContent)에 섞이지 않는다.
            <span className={styles.initial} data-initial={initial} aria-hidden="true" />
          ) : (
            <span className={styles.initial} aria-hidden="true">
              {initial}
            </span>
          )}
        </>
      ) : (
        <img
          className={styles.image}
          src={src}
          alt={alt}
          width={width}
          height={height}
          loading="lazy"
          onError={() => setFailedSrc(src)}
        />
      )}
    </span>
  );
}
