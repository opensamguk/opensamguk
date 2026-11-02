import { PUBLIC_IMAGES } from '../packages/shared/src/publicImages';

// 화면 시험의 외부 요청 관측 판정. 생산 정책이 아니라 시험이 무엇을 외부 유출로 셀지만 정한다.
// D-060: 앱 출처 밖으로는 공통 승인 이미지(PUBLIC_IMAGES)의 고정 주소를 이미지로 읽는 것만 허용한다.
// 호스트나 경로 접두로 넓히지 않는다. query·다른 커밋·다른 요청 종류·목록 밖 경로(원작 초상, 개발 도구 이미지)는 모두 외부다.
const WEB_PROTOCOLS = ['http:', 'https:', 'ws:', 'wss:'];
const APPROVED_IMAGE_URLS: ReadonlySet<string> = new Set(PUBLIC_IMAGES.map((image) => image.url));

export interface ObservedRequest {
  url: string;
  resourceType: string;
}

// 외부 유출이면 그 출처를, 아니면 null을 돌려준다.
export function externalOrigin(request: ObservedRequest, appHost: string): string | null {
  const url = new URL(request.url);
  if (!WEB_PROTOCOLS.includes(url.protocol) || url.host === appHost) return null;
  if (request.resourceType === 'image' && APPROVED_IMAGE_URLS.has(request.url)) return null;
  return url.origin;
}
