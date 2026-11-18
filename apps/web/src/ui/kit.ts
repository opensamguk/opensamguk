// 쇼케이스 UI 키트 그림(INT-29). 승인 목록의 그림 주소를 CSS 변수로 :root에 올려 두고,
// 전역 키트 클래스(styles/kit.css)가 그 변수로 아홉 조각 틀과 상태 그림을 그린다.
// 여러 상태가 붙은 키트 A 그림은 상태마다 자른 그림(ui/kit-a/states/<이름>-<번호>.webp)을 쓴다.
// 상태 번호: 단추 0 기본, 1 올림, 2 누름, 3 불가. 탭 0 고름, 1 안 고름. 표 줄 0 짝, 1 홀, 2 고름.
// 입력칸 0 기본, 1 초점, 2 오류, 3 불가. 라디오와 확인칸 0 빈 칸, 1 찬 칸, 2 불가.
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';

const A = (name: string) => `apps/web/src/art/ui/kit-a/${name}.webp`;
const S = (name: string, state: number) => `apps/web/src/art/ui/kit-a/states/${name}-${state}.webp`;

/** CSS 변수 이름(앞의 --kit- 뺀 것)과 그림 경로. */
export const KIT_IMAGES: ReadonlyArray<readonly [string, string]> = [
  ...[
    'frame-window',
    'frame-list-general',
    'frame-list-city',
    'frame-list-nation',
    'frame-list-paper',
    'frame-card',
    'frame-notice',
    'frame-speech',
    'frame-tooltip',
    'drawer',
    'bar-top',
    'bar-bottom',
    'divider',
    'gauge-track',
    'select-list',
  ].map((name) => [name, A(name)] as const),
  ...(['button-primary', 'button-secondary', 'button-danger', 'button-accent', 'button-round'] as const).flatMap(
    (name) => [0, 1, 2, 3].map((state) => [`${name}-${state}`, S(name, state)] as const),
  ),
  ...(['input-text', 'select'] as const).flatMap((name) =>
    [0, 1, 2, 3].map((state) => [`${name}-${state}`, S(name, state)] as const),
  ),
  ...(['tab-horizontal', 'tab-vertical', 'title-ornament'] as const).flatMap((name) =>
    [0, 1].map((state) => [`${name}-${state}`, S(name, state)] as const),
  ),
  ...[0, 1, 2].map((state) => [`table-row-${state}`, S('table-row', state)] as const),
  ...(['radio', 'checkbox'] as const).flatMap((name) =>
    [0, 1, 2].map((state) => [`${name}-${state}`, S(name, state)] as const),
  ),
  ...[0, 1, 2, 3].map((state) => [`gauge-fill-${state}`, S('gauge-fill', state)] as const),
  ['table-head', A('table-head')],
];

/** 승인 목록에 있는 키트 그림만 CSS 변수로 만든다. 없는 그림은 변수를 두지 않아 CSS 대체 색이 보인다. */
export function kitVariables(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, source] of KIT_IMAGES) {
    if (hasPublicImage(source)) out[`--kit-${name}`] = `url("${publicImageUrl(source)}")`;
  }
  return out;
}

/** 앱을 띄울 때 한 번 :root에 키트 변수를 올린다. */
export function installKit(root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(kitVariables())) root.style.setProperty(name, value);
}
