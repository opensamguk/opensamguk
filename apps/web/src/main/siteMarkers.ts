import { publicImageUrl } from '@opensamguk/shared/public-images';
import type { MapNation } from '../game/types';
const level0 = publicImageUrl('apps/web/src/art/map/level-0.png');
const level0Large = publicImageUrl('apps/web/src/art/map/level-0@128.png');
const level4 = publicImageUrl('apps/web/src/art/map/level-4.png');
const level4Large = publicImageUrl('apps/web/src/art/map/level-4@128.png');
const level5 = publicImageUrl('apps/web/src/art/map/level-5.png');
const level5Large = publicImageUrl('apps/web/src/art/map/level-5@128.png');
const level6 = publicImageUrl('apps/web/src/art/map/level-6.png');
const level6Large = publicImageUrl('apps/web/src/art/map/level-6@128.png');
const level7 = publicImageUrl('apps/web/src/art/map/level-7.png');
const level7Large = publicImageUrl('apps/web/src/art/map/level-7@128.png');
const level8 = publicImageUrl('apps/web/src/art/map/level-8.png');
const level8Large = publicImageUrl('apps/web/src/art/map/level-8@128.png');
const level9 = publicImageUrl('apps/web/src/art/map/level-9.png');
const level9Large = publicImageUrl('apps/web/src/art/map/level-9@128.png');
const ruin = publicImageUrl('apps/web/src/art/map/ruin.png');
const ruinLarge = publicImageUrl('apps/web/src/art/map/ruin@128.png');
const port = publicImageUrl('apps/web/src/art/map/port.png');
const portLarge = publicImageUrl('apps/web/src/art/map/port@128.png');
const passWall = publicImageUrl('apps/web/src/art/map/pass-wall.png');
const passWallLarge = publicImageUrl('apps/web/src/art/map/pass-wall@128.png');
const passWallEw = publicImageUrl('apps/web/src/art/map/pass-wall-ew.png');
const passWallEwLarge = publicImageUrl('apps/web/src/art/map/pass-wall-ew@128.png');
const field = publicImageUrl('apps/web/src/art/map/field.png');
const fieldLarge = publicImageUrl('apps/web/src/art/map/field@128.png');
const ford = publicImageUrl('apps/web/src/art/map/ford.png');
const fordLarge = publicImageUrl('apps/web/src/art/map/ford@128.png');

// 지도 표식 규칙 (INT-20, D-047·D-048, docs/design/visual-identity.md).
// 표식은 위에서 내려다본 그림이고 규모마다 1000×700 지도 단위 크기가 다르다.
// 화면에서 16px보다 작으면 국가색 네모로 줄이고 48px까지는 32px 그림, 그보다 크면 128px 그림을 쓴다.

export type SiteKind = 'CITY' | 'PASS' | 'PORT' | 'FIELD';
export type PassAxis = 'ns' | 'ew';
export type GateDir = 'N' | 'E' | 'S' | 'W';
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
  pass: art('pass-wall', passWall, passWallLarge),
  passEw: art('pass-wall-ew', passWallEw, passWallEwLarge),
  field: art('field', field, fieldLarge),
  ford: art('ford', ford, fordLarge),
};
export const FORD_ART = ART.ford;

// 규모: 0 무, 1 수, 2 진, 3 관, 4 이, 5 소, 6 중, 7 대, 8 특, 9 경.
export const LEVEL_NAMES = ['무', '수', '진', '관', '이', '소', '중', '대', '특', '경'] as const;
// INT-20 사용자 요청으로 줄였다. 진(2)과 진영은 확실히 작게 둔다.
const LEVEL_UNITS = [5, 6, 4, 6, 6, 7, 8, 9, 11, 13] as const;
const FACILITY_UNITS: Record<Exclude<SiteKind, 'CITY'>, number> = { PASS: 6, PORT: 6, FIELD: 3.5 };
// D-052: 관은 길을 가로막는 긴 성벽 띠다. 남북 길이면 가로 12×세로 3, 동서 길이면 가로 3×세로 12 지도 단위다.
export const PASS_WALL = { long: 12, short: 3 } as const;
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

const isPass = (kind: SiteKind, level?: number) => kind === 'PASS' || (kind === 'CITY' && knownLevel(level) === 3);

/** 그림 상자 크기(지도 단위). 관만 길쭉하고 나머지는 정사각형이다. */
export function markerBox(kind: SiteKind, level?: number, axis?: PassAxis): { width: number; height: number } {
  if (isPass(kind, level))
    return axis === 'ew'
      ? { width: PASS_WALL.short, height: PASS_WALL.long }
      : { width: PASS_WALL.long, height: PASS_WALL.short };
  const units = markerUnits(kind, level);
  return { width: units, height: units };
}

// D-052 사용자 요청: 길은 그림에 실제로 있는 문으로만 드나든다. undefined는 담이 없어 어느 쪽이든 된다.
// 진·소·수는 남문 하나, 중은 남북 문, 대·특·경은 네 문이다. 관은 길 방향 양쪽 문이다.
export function markerGates(kind: SiteKind, level?: number, axis?: PassAxis): readonly GateDir[] | undefined {
  if (isPass(kind, level)) return axis === 'ew' ? ['E', 'W'] : ['N', 'S'];
  if (kind !== 'CITY') return undefined;
  switch (knownLevel(level) ?? 5) {
    case 1:
    case 2:
    case 5:
      return ['S'];
    case 6:
      return ['N', 'S'];
    case 7:
    case 8:
    case 9:
      return ['N', 'E', 'S', 'W'];
    default:
      return undefined;
  }
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

// 공개 지도 사본은 수도를 저장하지 않는다(T4-56). 수도가 없으면 별표를 달지 않는다.
export type DrawnNation = Pick<MapNation, 'id' | 'name' | 'color'> & { capitalCityKey?: number | null };

// 수도는 도시 이름 앞 별표로 누구에게나 보인다 (D-053).
export const CAPITAL_MARK = '★';
export const isCapital = (city: { key: number }, nation: DrawnNation | undefined) =>
  nation?.capitalCityKey === city.key;
