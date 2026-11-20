import type { CSSProperties } from 'react';
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import { readableTextColor } from './color';
import styles from './NationBadge.module.css';

// 국가색은 이름표와 지도에만 쓴다 (UI 지침 원칙 3).
// 이름 앞의 도트 군기는 장식이라 읽지 않는다. 깃천만 국가색으로 물들인다 (INT-20).
// 이름패는 무채색 옻칠 판 그림에 국가색을 곱하고 놋쇠 테두리를 얹는다. 나라 색은 아무 #RRGGBB나 되므로
// 색마다 그림을 두지 않는다 (사용자 2026-11-15 "국가색 칩은 어떻게 만들거지?" → "이 방식으로 진행").
const art = (name: string) => `url(${publicImageUrl(`apps/web/src/art/nation/${name}.webp`)})`;
let chipArt: CSSProperties | null = null;
function chipVars(): CSSProperties {
  // 그림이 승인 목록에 오기 전에는 단색 이름패로 둔다.
  if (!hasPublicImage('apps/web/src/art/nation/chip-field-mid.webp')) return {};
  chipArt ??= {
    '--chip-field-left': art('chip-field-left'),
    '--chip-field-mid': art('chip-field-mid'),
    '--chip-field-right': art('chip-field-right'),
    '--chip-rim-left': art('chip-rim-left'),
    '--chip-rim-mid': art('chip-rim-mid'),
    '--chip-rim-right': art('chip-rim-right'),
    '--flag-field': art('flag-field'),
    '--flag-rim': art('flag-rim'),
  } as CSSProperties;
  return chipArt;
}

/** 이름이 없는 땅(공백지, 재야)은 빛바랜 한지 빛 판에 흐린 글자로 둔다. */
const NONE_COLOR = '#cfc6b4';

export function NationBadge({ name, color }: { name: string; color: string | null }) {
  const tint = color ?? NONE_COLOR;
  const style = { ...chipVars(), '--nation': tint, color: readableTextColor(tint) } as CSSProperties;
  return (
    <span className={styles.badge}>
      {color === null ? null : <span className={styles.flag} style={style} aria-hidden="true" />}
      <span className={styles.chip} data-none={color === null ? 'true' : undefined} style={style}>
        <span className={styles.left} aria-hidden="true" />
        <span className={styles.name}>{name}</span>
        <span className={styles.right} aria-hidden="true" />
      </span>
    </span>
  );
}
