// 초상 경로 규칙: docs/image-assets.md §2. 게임 데이터는 초상 ID만 저장하고 주소는 화면이 만든다 (FR-IMG-01·02).

// 이미지 서버(T2-15) 전 개발 기본값. 이미지 저장소 2026-10-20 정리 커밋에 고정한다.
export const DEFAULT_IMAGE_BASE_URL =
  'https://cdn.jsdelivr.net/gh/opensamguk/opensamguk-images@48163bd1ce8d54c54c94fb5484b05f9db9e50c62';

export const PORTRAIT_ID_MIN = 10001;
export const PORTRAIT_ID_MAX = 11000;

export const PORTRAIT_VARIANTS = {
  portrait: { ext: 'png', width: 148, height: 210 },
  icon: { ext: 'webp', width: 96, height: 96 },
  thumb: { ext: 'webp', width: 48, height: 68 },
} as const;

export type PortraitVariant = keyof typeof PORTRAIT_VARIANTS;

// 비었으면 기본값. 끝의 /는 떼어 경로를 붙일 때 //가 생기지 않게 한다.
export function resolveImageBaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? '';
  return (trimmed === '' ? DEFAULT_IMAGE_BASE_URL : trimmed).replace(/\/+$/, '');
}

// VITE_IMAGE_BASE_URL은 빌드 때 박힌다. 값만 바꿔 다시 빌드하면 모든 초상 주소가 바뀐다.
export const imageBaseUrl = resolveImageBaseUrl(import.meta.env.VITE_IMAGE_BASE_URL);

export function isPortraitId(id: number | null | undefined): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id >= PORTRAIT_ID_MIN && id <= PORTRAIT_ID_MAX;
}

// 범위 밖이거나 null이면 null을 돌려준다. 이때 화면은 기본 이미지를 쓴다.
export function portraitUrl(
  id: number | null | undefined,
  variant: PortraitVariant,
  base: string = imageBaseUrl,
): string | null {
  if (!isPortraitId(id)) return null;
  return `${base}/portraits/${variant}/${id}.${PORTRAIT_VARIANTS[variant].ext}`;
}
