// 성 화면 미리보기 아티팩트 전용(사용자 2026-11-17 "아티팩트에 반영해."). 아티팩트는 다른 주소의 그림을 못 불러와서
// 그림을 묶음 파일로 함께 올리고, 받은 그림을 blob 주소로 바꿔 이 표에 넣는다. vite.castle-preview.config.ts가
// '@opensamguk/shared/public-images'를 이 파일로 바꿔 끼운다. 게임 빌드에는 들어가지 않는다.
const art = (): Map<string, string> => {
  const g = globalThis as { __CASTLE_ART?: Map<string, string> };
  g.__CASTLE_ART ??= new Map();
  return g.__CASTLE_ART;
};
// 받은 그림이 늘 때마다 진입점(castlePreviewMain.tsx)이 여기 채운다. 확인 판이 양식의 지역 건물 키를 이 목록에서 찾는다.
export const PUBLIC_IMAGES: Array<{ source: string; url: string; sha256: string }> = [];
export function publicImageUrl(source: string): string {
  const url = art().get(source);
  if (!url) throw new Error('미리보기에 넣지 않은 그림입니다.');
  return url;
}
export function hasPublicImage(source: string): boolean {
  return art().has(source);
}
