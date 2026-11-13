import { PLAYER_PORTRAIT_MIN_ID } from '@opensamguk/shared';
import { resolveImageBaseUrl } from './imageBase';

export { DEFAULT_IMAGE_BASE_URL, resolveImageBaseUrl } from './imageBase';

// 초상 경로 규칙: docs/image-assets.md §2. 게임 데이터는 초상 ID만 저장하고 주소는 화면이 만든다 (FR-IMG-01·02).
// 공개 빌드(`vite build --mode public`)도 같은 규칙으로 초상을 보인다 (D-087, D-031의 공개 빌드 초상 부분을 대체).

export const PORTRAIT_ID_MIN = 10001;
export const PORTRAIT_ID_MAX = 11008;

export const PORTRAIT_VARIANTS = {
  portrait: { ext: 'png', width: 148, height: 210 },
  icon: { ext: 'webp', width: 96, height: 96 },
  thumb: { ext: 'webp', width: 48, height: 68 },
} as const;

export type PortraitVariant = keyof typeof PORTRAIT_VARIANTS;

// VITE_IMAGE_BASE_URL은 빌드 때 박힌다. 값만 바꿔 다시 빌드하면 모든 초상 주소가 바뀐다.
// 공개 빌드에서는 vite.config.ts가 https 주소인지 보고, 공개 자산 검사가 승인 목록(remoteImageBases)과 대조한다.
export const imageBaseUrl = resolveImageBaseUrl(import.meta.env.VITE_IMAGE_BASE_URL);

export function isPortraitId(id: number | null | undefined): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id >= PORTRAIT_ID_MIN && id <= PORTRAIT_ID_MAX;
}

// 범위 밖이거나 null이면 null을 돌려준다. 이때 화면은 기본 이미지를 쓴다.
// 계정 초상은 같은 출처에서 제공한다. 보충 8명(11001~11008)은 개발 서버에서만 원본을 읽는다.
export function portraitUrl(
  id: number | null | undefined,
  variant: PortraitVariant,
  base: string = imageBaseUrl,
): string | null {
  if (typeof id === 'number' && Number.isInteger(id) && id >= PLAYER_PORTRAIT_MIN_ID && id <= 2_147_483_647)
    return `/trpc/player-portrait/${id}`;
  if (!isPortraitId(id)) return null;
  if (id > 11000) return import.meta.env.DEV ? `/__dev-portraits/${id}` : null;
  return `${base}/portraits/${variant}/${id}.${PORTRAIT_VARIANTS[variant].ext}`;
}

// 서버 응답에 portraitId가 있으면 그 값을, 없으면 null(실루엣)을 준다.
// 메시지·순위처럼 아직 초상 번호를 주지 않는 응답도 같은 화면 코드로 쓰고, 서버가 값을 더하면 바로 얼굴이 보인다 (INT-26).
export function portraitIdOf(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || !('portraitId' in value)) return null;
  const id = value.portraitId;
  return typeof id === 'number' ? id : null;
}
