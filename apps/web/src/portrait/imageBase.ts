// 초상 이미지 base 주소. vite.config.ts도 읽으므로 import.meta.env를 쓰지 않는 순수 모듈로 둔다.

// 이미지 서버(T2-15) 전 기본값. jsDelivr의 50MB 패키지 제한을 피하고 같은 고정 커밋의 원본을 읽는다.
// 공개 빌드도 같은 값을 쓴다 (D-086). 바꾸면 manifest/public-assets.json의 remoteImageBases도 같이 고친다.
export const DEFAULT_IMAGE_BASE_URL =
  'https://raw.githubusercontent.com/opensamguk/opensamguk-images/48163bd1ce8d54c54c94fb5484b05f9db9e50c62';

// 비었으면 기본값. 끝의 /는 떼어 경로를 붙일 때 //가 생기지 않게 한다.
export function resolveImageBaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? '';
  return (trimmed === '' ? DEFAULT_IMAGE_BASE_URL : trimmed).replace(/\/+$/, '');
}
