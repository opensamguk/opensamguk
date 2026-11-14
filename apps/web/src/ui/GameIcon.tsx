// 게임 아이콘 (INT-29, 사용자 2026-11-14: 웹사이트가 아니라 게임처럼). 게임 화면 틀과 기록 줄 앞 아이콘이 함께 쓴다.
// 외부 그림 없이 24×24 선 그림으로만 그린다. 색은 currentColor를 따른다.
import type { SVGProps } from 'react';

export type StageIconName =
  | 'general'
  | 'city'
  | 'nation'
  | 'records'
  | 'turns'
  | 'menu'
  | 'message'
  | 'soundOn'
  | 'soundOff'
  | 'gold'
  | 'rice'
  | 'troops'
  | 'close'
  | 'back'
  // 기록 종류
  | 'battle'
  | 'victory'
  | 'defeat'
  | 'found'
  | 'fall'
  | 'declare'
  | 'capture'
  | 'domestic'
  | 'betrayal'
  | 'success'
  | 'failure'
  | 'review';

const PATHS: Record<StageIconName, string> = {
  // 투구 쓴 장수
  general:
    'M12 3c-3.3 0-6 2.5-6 6v2h12V9c0-3.5-2.7-6-6-6Zm0 0v3M6 11l-1 3h14l-1-3M8 14v2a4 4 0 0 0 8 0v-2M7 21c.5-2 2.6-3 5-3s4.5 1 5 3',
  // 성문과 성가퀴
  city: 'M3 21V9h3V6h3v3h6V6h3v3h3v12M3 21h18M10 21v-5a2 2 0 0 1 4 0v5M3 12h18',
  // 깃발
  nation: 'M5 21V3M5 4h11l-2 4 2 4H5',
  // 두루마리
  records:
    'M7 4h11a2 2 0 0 1 2 2v1h-3M7 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M7 4a2 2 0 0 1 2 2v12M11 9h5M11 13h5M11 17h3',
  // 영패(명령)
  turns: 'M8 3h8l2 3v15H6V6l2-3ZM9 9h6M9 13h6M9 17h4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  // 서신
  message: 'M3 6h18v12H3zM3 7l9 6 9-6',
  soundOn: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  soundOff: 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6',
  // 엽전
  gold: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-3 6h6v6H9z',
  // 쌀가마
  rice: 'M6 8c0-2 2.5-3 6-3s6 1 6 3l1 9c0 2-3 3-7 3s-7-1-7-3l1-9ZM6 8c1 1.2 3.4 1.8 6 1.8S17 9.2 18 8M9 13h6',
  // 창 두 자루
  troops: 'M5 21 17 5M19 21 7 5M15 3l4 1-1 4M9 3 5 4l1 4',
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M15 5l-7 7 7 7',
  // 엇갈린 칼
  battle: 'M4 4l9 9M20 4l-9 9M6 16l-2 4 4-2M18 16l2 4-4-2M8 14l-2 2M16 14l2 2',
  // 칼 위 월계(승리)
  victory: 'M12 3v12M9 12h6M12 15v3M6 8c0 4 2 7 6 7s6-3 6-7M5 21h14',
  // 꺾인 칼(패배)
  defeat: 'M5 19l6-6M13 11l6-6M10 8l3 3M4 20l3-1-2-2zM14 16l4 4',
  // 꽂은 깃발(건국)
  found: 'M6 21V3M6 4h11l-2 4 2 4H6M3 21h8',
  // 부러진 깃대(멸망)
  fall: 'M6 21v-7M6 10V3M6 4h9l-2 3 2 3H6M4 12l4 1M3 21h7',
  // 격문(선전포고)
  declare: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M14 15l3-3',
  // 성 위 깃발(점령)
  capture: 'M4 21V12h3v-2h3v2h4v-2h3v2h3v9M4 21h16M12 12V4l5 2-5 2',
  // 괭이(내정)
  domestic: 'M5 21 15 11M13 5c2-2 5-2 6 0l-4 4c-2-1-3-2-2-4ZM9 17l-2-2',
  // 등 뒤의 칼(배신)
  betrayal: 'M12 3a4 4 0 0 0-4 4v3h8V7a4 4 0 0 0-4-4ZM7 21v-6l5-3 5 3v6M18 6l3-3M16 9l2-2',
  success: 'M5 12l5 5 9-10',
  failure: 'M6 6l12 12M18 6 6 18',
  // 붓(월단평)
  review: 'M14 4l6 6-8 8-4 1 1-4 8-8M4 21c2 0 3-1 3-3',
};

export function StageIcon({
  name,
  size = 24,
  ...rest
}: { name: StageIconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
