import catalog from './publicImageCatalog.json' with { type: 'json' };

export const PUBLIC_IMAGES = catalog;
const urls = new Map(PUBLIC_IMAGES.map((image) => [image.source, image.url]));

/** 같은 승인 목록과 고정 커밋을 Node·Workers 화면이 함께 쓴다. */
export function publicImageUrl(source: string): string {
  const url = urls.get(source);
  if (!url) throw new Error('승인한 공개 이미지 경로가 아닙니다.');
  return url;
}
