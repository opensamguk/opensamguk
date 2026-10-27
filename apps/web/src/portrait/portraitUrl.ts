// 초상 경로 규칙: docs/image-assets.md §2. 게임 데이터는 초상 ID만 저장하고 주소는 화면이 만든다 (FR-IMG-01·02).

// 공개 빌드(`vite build --mode public`)는 초상을 기본 이미지로만 보여 준다 (D-031, T3-13).
// 조건은 빌드 때 상수로 바뀌므로 아래 주소 문자열과 경로 틀이 공개 번들에서 지워진다. 변수에 담지 않고 그 자리에 쓴다.

// 이미지 서버(T2-15) 전 개발 기본값. jsDelivr의 50MB 패키지 제한을 피하고 같은 고정 커밋의 원본을 읽는다.
export const DEFAULT_IMAGE_BASE_URL =
  import.meta.env.MODE === 'public'
    ? ''
    : 'https://raw.githubusercontent.com/opensamguk/opensamguk-images/48163bd1ce8d54c54c94fb5484b05f9db9e50c62';

export const PORTRAIT_ID_MIN = 10001;
export const PORTRAIT_ID_MAX = 11008;

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
// 공개 빌드는 이 값을 쓰지 않는다. 값이 있으면 vite.config.ts가 빌드를 멈춘다.
export const imageBaseUrl =
  import.meta.env.MODE === 'public' ? '' : resolveImageBaseUrl(import.meta.env.VITE_IMAGE_BASE_URL);

export function isPortraitId(id: number | null | undefined): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id >= PORTRAIT_ID_MIN && id <= PORTRAIT_ID_MAX;
}

// 범위 밖이거나 null이면 null을 돌려준다. 이때 화면은 기본 이미지를 쓴다.
// 공개 빌드는 유효한 ID와 명시한 base 인자에도 늘 null이다.
export function portraitUrl(
  id: number | null | undefined,
  variant: PortraitVariant,
  base: string = imageBaseUrl,
): string | null {
  if (import.meta.env.MODE === 'public') return null;
  if (!isPortraitId(id)) return null;
  if (id > 11000) return import.meta.env.DEV ? `/__dev-portraits/${id}` : null;
  return `${base}/portraits/${variant}/${id}.${PORTRAIT_VARIANTS[variant].ext}`;
}
