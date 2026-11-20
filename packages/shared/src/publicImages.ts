import catalog from './publicImageCatalog.json' with { type: 'json' };

export const PUBLIC_IMAGES = catalog;
const urls = new Map(PUBLIC_IMAGES.map((image) => [image.source, image.url]));

/** 같은 승인 목록과 고정 커밋을 Node·Workers 화면이 함께 쓴다. */
export function publicImageUrl(source: string): string {
  const url = urls.get(source);
  if (!url) throw new Error('승인한 공개 이미지 경로가 아닙니다.');
  return url;
}

/** 그림이 아직 승인 목록에 없을 수 있는 자리(예: 명령마다 그린 글자)에서 먼저 묻는다. */
export function hasPublicImage(source: string): boolean {
  return urls.has(source);
}
