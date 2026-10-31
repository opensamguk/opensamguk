import level0 from '../art/map/level-0.png';
import level0Large from '../art/map/level-0@128.png';
import level4 from '../art/map/level-4.png';
import level4Large from '../art/map/level-4@128.png';
import level5 from '../art/map/level-5.png';
import level5Large from '../art/map/level-5@128.png';
import level6 from '../art/map/level-6.png';
import level6Large from '../art/map/level-6@128.png';
import level7 from '../art/map/level-7.png';
import level7Large from '../art/map/level-7@128.png';
import level8 from '../art/map/level-8.png';
import level8Large from '../art/map/level-8@128.png';
import level9 from '../art/map/level-9.png';
import level9Large from '../art/map/level-9@128.png';
import ruin from '../art/map/ruin.png';
import ruinLarge from '../art/map/ruin@128.png';
import port from '../art/map/port.png';
import portLarge from '../art/map/port@128.png';
import pass from '../art/map/pass.png';
import passLarge from '../art/map/pass@128.png';
import passEw from '../art/map/pass-ew.png';
import passEwLarge from '../art/map/pass-ew@128.png';
import field from '../art/map/field.png';
import fieldLarge from '../art/map/field@128.png';
import ford from '../art/map/ford.png';
import fordLarge from '../art/map/ford@128.png';

// 지도 표식 규칙 (INT-20, D-047·D-048, docs/design/visual-identity.md).
// 표식은 위에서 내려다본 그림이고 규모마다 1000×700 지도 단위 크기가 다르다.
// 화면에서 16px보다 작으면 국가색 네모로 줄이고 48px까지는 32px 그림, 그보다 크면 128px 그림을 쓴다.

export type SiteKind = 'CITY' | 'PASS' | 'PORT' | 'FIELD';
export type PassAxis = 'ns' | 'ew';
export interface MarkerArt {
  name: string;
  small: string;
  large: string;
}

const art = (name: string, small: string, large: string): MarkerArt => ({ name, small, large });
const ART = {
  level0: art('level-0', level0, level0Large),
  level4: art('level-4', level4, level4Large),
  level5: art('level-5', level5, level5Large),
  level6: art('level-6', level6, level6Large),
  level7: art('level-7', level7, level7Large),
  level8: art('level-8', level8, level8Large),
  level9: art('level-9', level9, level9Large),
  ruin: art('ruin', ruin, ruinLarge),
  port: art('port', port, portLarge),
  pass: art('pass', pass, passLarge),
  passEw: art('pass-ew', passEw, passEwLarge),
  field: art('field', field, fieldLarge),
  ford: art('ford', ford, fordLarge),
};
export const FORD_ART = ART.ford;

// 규모: 0 무, 1 수, 2 진, 3 관, 4 이, 5 소, 6 중, 7 대, 8 특, 9 경.
export const LEVEL_NAMES = ['무', '수', '진', '관', '이', '소', '중', '대', '특', '경'] as const;
// INT-20 사용자 요청으로 줄였다. 진(2)과 진영은 확실히 작게 둔다.
const LEVEL_UNITS = [5, 6, 4, 6, 6, 7, 8, 9, 11, 13] as const;
const FACILITY_UNITS: Record<Exclude<SiteKind, 'CITY'>, number> = { PASS: 6, PORT: 6, FIELD: 3.5 };
export const SQUARE_BELOW_PX = 16;
export const SMALL_UP_TO_PX = 48;

const knownLevel = (level: number | undefined) =>
  level !== undefined && Number.isInteger(level) && level >= 0 && level < LEVEL_NAMES.length ? level : undefined;

export function levelName(level: number | undefined): string | undefined {
  const known = knownLevel(level);
  return known === undefined ? undefined : LEVEL_NAMES[known];
}

// 지도 단위 크기. 규모를 모르는 도시는 소(10)로 둔다.
export function markerUnits(kind: SiteKind, level?: number): number {
  if (kind !== 'CITY') return FACILITY_UNITS[kind];
  return LEVEL_UNITS[knownLevel(level) ?? 5] ?? LEVEL_UNITS[5];
}

export function markerArt(
  kind: SiteKind,
  level?: number,
  options: { ruined?: boolean | undefined; axis?: PassAxis | undefined } = {},
) {
  const passArt = options.axis === 'ew' ? ART.passEw : ART.pass;
  if (kind === 'PASS') return passArt;
  if (kind === 'PORT') return ART.port;
  if (kind === 'FIELD') return ART.field;
  if (options.ruined) return ART.ruin;
  switch (knownLevel(level)) {
    case 0:
      return ART.level0;
    case 1:
      return ART.port;
    case 2:
      return ART.field;
    case 3:
      return passArt;
    case 4:
      return ART.level4;
    case 6:
      return ART.level6;
    case 7:
      return ART.level7;
    case 8:
      return ART.level8;
    case 9:
      return ART.level9;
    default:
      return ART.level5;
  }
}

export type MarkerDetail = 'square' | 'small' | 'large';

// 지도 단위 크기와 화면 배율(화면 px / 지도 단위)로 그릴 방식을 고른다.
export function markerDetail(units: number, pixelsPerUnit: number): MarkerDetail {
  const px = units * pixelsPerUnit;
  if (!Number.isFinite(px) || px < SQUARE_BELOW_PX) return 'square';
  return px <= SMALL_UP_TO_PX ? 'small' : 'large';
}

// 관문을 지나는 도로의 이웃 점으로 방향을 정한다. 세로 성분이 크면 남북판, 아니면 동서판이다.
// 이웃이 없으면 남북판을 쓴다.
export function passAxis(at: { x: number; y: number }, neighbours: readonly { x: number; y: number }[]): PassAxis {
  let dx = 0;
  let dy = 0;
  for (const point of neighbours) {
    const length = Math.hypot(point.x - at.x, point.y - at.y);
    if (!length) continue;
    dx += Math.abs(point.x - at.x) / length;
    dy += Math.abs(point.y - at.y) / length;
  }
  return dx > dy ? 'ew' : 'ns';
}
