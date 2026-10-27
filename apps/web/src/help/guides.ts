// 웹 빌드가 docs/user/의 가이드를 글 그대로 묶는다 (T2-17 도움말 도달 경로). 서버 API는 쓰지 않는다.
// 생성 목록(command-catalog.generated.md, T2-16)도 파일이 생기면 같은 방식으로 함께 묶인다.
const files = import.meta.glob('../../../../docs/user/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export const GUIDES: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [path.replace(/^.*\/([^/]+)\.md$/, '$1'), text]),
);

// 읽는 순서 (계획 T2-17 결정: 기초 → 초급 → 중급 → 참고).
export const GUIDE_ORDER = [
  { doc: 'index', title: '시작하기' },
  { doc: 'integration-v01', title: '통합판의 5능력치와 휘하·부곡' },
  { doc: 'general-and-city', title: '장수와 도시, 내정' },
  { doc: 'time-and-turns', title: '시간과 턴' },
  { doc: 'war-and-orders', title: '전쟁과 예턴 조합' },
  { doc: 'map-and-supply', title: '지도와 보급' },
  { doc: 'economy-and-diplomacy', title: '국가 재정과 외교' },
  { doc: 'nation-and-features', title: '국가 운영과 주요 기능' },
  { doc: 'glossary', title: '용어 사전' },
  { doc: 'commands-and-timing', title: '명령과 실행 시기' },
] as const;

// T2-16(Codex)이 만들 생성 목록. 파일이 생기기 전에는 도움말에서 준비 중으로 보인다.
export const CATALOG_DOC = 'command-catalog.generated';
