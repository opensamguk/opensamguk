// 게임 아이콘 (INT-29, 사용자 2026-11-14: 웹사이트가 아니라 게임처럼). 게임 화면 틀과 기록 줄 앞 아이콘이 함께 쓴다.
// 외부 그림 없이 24×24 선 그림으로만 그린다. 색은 currentColor를 따른다.
import type { SVGProps } from 'react';
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';

export type StageIconName =
  | 'general'
  | 'city'
  | 'map'
  | 'realm'
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
  // 접은 지도(전체 지도)
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6Zm6-2v14m6-12v14',
  // 천하 형세(세력 견주기)
  realm: 'M4 20h16M6 20V10h3v10M10.5 20V6h3v14M15 20v-7h3v7',
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

// 쇼케이스 UI 키트 B 아이콘(INT-29). 그림이 승인 목록에 있으면 선 그림 대신 이 그림을 쓴다.
// 사용자 2026-11-15: "그리고 왜 아이콘 만든게 안나오지?" 기록 종류 아이콘(전투, 승리 등)은 글자 줄 안에 들어가 선 그림을 둔다.
const KIT_ICONS: Partial<Record<StageIconName, string>> = {
  general: 'icon-nav-account',
  city: 'icon-nav-logout',
  map: 'icon-nav-map',
  realm: 'icon-nav-ranking',
  nation: 'icon-nav-nation',
  records: 'icon-nav-records',
  turns: 'icon-nav-turns',
  message: 'icon-nav-messages',
  menu: 'icon-nav-settings',
  gold: 'icon-res-gold',
  rice: 'icon-res-rice',
  troops: 'icon-res-troops',
};

export function kitIconUrl(name: StageIconName): string | null {
  const file = KIT_ICONS[name];
  if (!file) return null;
  const source = `apps/web/src/art/ui/kit-b/${file}.webp`;
  return hasPublicImage(source) ? publicImageUrl(source) : null;
}

export function StageIcon({
  name,
  size = 24,
  ...rest
}: { name: StageIconName; size?: number } & SVGProps<SVGSVGElement>) {
  const kit = kitIconUrl(name);
  if (kit)
    // 키트 그림은 테두리가 없어 같은 칸에서 조금 크게 그린다.
    return (
      <img
        src={kit}
        alt=""
        aria-hidden="true"
        width={Math.round(size * 1.25)}
        height={Math.round(size * 1.25)}
        className={typeof rest.className === 'string' ? rest.className : undefined}
        style={{
          objectFit: 'contain',
          verticalAlign: `calc(var(--glyph-mid) - ${(size * 1.25) / 2}px)`,
          marginBlock: `min(0px, calc((1em - ${size * 1.25}px) / 2))`,
        }}
        data-icon={name}
      />
    );
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
      // 글자 줄 안에 들어가면 한글 가운데 높이에 가운데를 맞추고 줄 높이를 늘리지 않는다(tokens.css --glyph-mid 규칙).
      // flex, grid 안에서는 이 두 속성이 쓰이지 않는다.
      style={{
        verticalAlign: `calc(var(--glyph-mid) - ${size / 2}px)`,
        marginBlock: `min(0px, calc((1em - ${size}px) / 2))`,
        ...rest.style,
      }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
