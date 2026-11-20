// 야전 칸 규칙 자료를 그림으로 잇는다 (D-105). 서버 응답 필드는 REPORT-field-rules.md "프런트 응답 필드"를 따른다.
// 그림은 Codex 야전 그리드 자산(objects, effects, marks, tiles)이고, 승인 목록에 없으면 null을 돌려 화면이 대신 도형을 그린다.
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import type {
  BattleBase,
  BattleBoardData,
  BattleCell,
  BattleObject,
  BattleUnit,
  Terrain,
  Weather,
  Wind,
} from './types';

export const cellKey = (x: number, y: number) => `${x},${y}`;

/** 승인한 전투 그림의 주소. 목록에 없으면 null. */
export function battleArt(name: string): string | null {
  const source = `apps/web/src/art/battle/${name}.webp`;
  return hasPublicImage(source) ? publicImageUrl(source) : null;
}

/** 칸 목록을 찾기 쉬운 묶음으로. 목록이 없으면(옛 프레임) null이라 가리지 않는다. */
export function cellSet(cells: readonly BattleCell[] | undefined): ReadonlySet<string> | null {
  return cells ? new Set(cells.map((cell) => cellKey(cell.x, cell.y))) : null;
}

export const WEATHER_LABEL: Record<Weather, string> = {
  clear: '맑음',
  rain: '비',
  downpour: '호우',
  snow: '눈',
  fog: '안개',
};

export const WIND_LABEL: Record<Wind, string> = {
  N: '북',
  NE: '북동',
  E: '동',
  SE: '남동',
  S: '남',
  SW: '남서',
  W: '서',
  NW: '북서',
};

const WIND_VECTOR: Record<Wind, readonly [number, number]> = {
  N: [0, -1],
  NE: [1, -1],
  E: [1, 0],
  SE: [1, 1],
  S: [0, 1],
  SW: [-1, 1],
  W: [-1, 0],
  NW: [-1, -1],
};

/**
 * 바람이 부는 쪽(불이 번지는 쪽)을 화면 방향으로. 판 x축은 화면 오른쪽 아래, y축은 왼쪽 아래로 눕는다.
 * dx, dy는 날씨 무늬 한 장 단위의 정수라 무늬를 그만큼 밀면 이음매 없이 되풀이된다. angle은 화면 각도(도, 오른쪽 0, 시계 방향).
 */
export function windScreen(wind: Wind): { dx: number; dy: number; angle: number } {
  const [bx, by] = WIND_VECTOR[wind];
  const dx = 2 * (bx - by);
  const dy = bx + by;
  // 실제 칸 투영은 (32(bx-by), 16(bx+by))라 각도는 그 비율로 잰다.
  const angle = Math.round((Math.atan2(16 * (bx + by), 32 * (bx - by)) * 180) / Math.PI);
  return { dx, dy, angle };
}

export interface WeatherOverlay {
  weather: Weather;
  /** 되풀이 무늬 그림 주소. 그림이 없으면 null(색만 덮는다). */
  url: string | null;
  /** 한 번 되풀이하는 동안 무늬가 움직이는 거리(무늬 장 수). 바람 방향에 내리는 몫을 더한다. */
  dx: number;
  dy: number;
  /** 한 번 되풀이하는 시간(초) */
  seconds: number;
}

/** 날씨 덮개. 맑으면 덮지 않는다. 비와 호우는 rain, 눈은 snow, 안개는 dust 무늬를 옅은 안개 빛 위에 깐다. */
export function weatherOverlay(weather: Weather | undefined, wind: Wind | undefined): WeatherOverlay | null {
  if (!weather || weather === 'clear') return null;
  const drift = windScreen(wind ?? 'S');
  const spec = {
    rain: { art: 'rain', fall: 4, seconds: 0.9 },
    downpour: { art: 'rain', fall: 6, seconds: 0.6 },
    snow: { art: 'snow', fall: 2, seconds: 7 },
    fog: { art: 'dust', fall: 0, seconds: 14 },
  }[weather];
  return {
    weather,
    url: battleArt(`effects/${spec.art}`),
    dx: drift.dx,
    dy: drift.dy + spec.fall,
    seconds: spec.seconds,
  };
}

/** 불 그림: 숲이거나 둘레 8칸 중 셋 이상이 타면 큰 불. */
export function fireArtName(board: BattleBoardData, burning: ReadonlySet<string>, x: number, y: number): string {
  if (board.terrain[y * board.width + x] === 'forest') return 'effects/fire-big';
  let around = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && burning.has(cellKey(x + dx, y + dy))) around++;
  return around >= 3 ? 'effects/fire-big' : 'effects/fire';
}

const WATER: ReadonlySet<Terrain> = new Set(['river', 'sea']);

/**
 * 다리 그림 방향. bridge-ne는 화면 왼쪽 아래↔오른쪽 위(판 y축), bridge-nw는 왼쪽 위↔오른쪽 아래(판 x축)로 놓인다.
 * 서버의 direction은 대각 이웃 기준이라 그림 축과 어긋날 수 있어, 먼저 물이 흐르는 축을 보고 그 축을 가로지르게 놓는다.
 * 물이 양쪽 축에 다 있거나 없으면 direction 이름을 그대로 따른다.
 */
export function bridgeArtName(board: BattleBoardData, object: BattleObject & { kind: 'bridge' }): string {
  const water = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < board.width && y < board.height && WATER.has(board.terrain[y * board.width + x]!);
  const alongX = water(object.x - 1, object.y) || water(object.x + 1, object.y);
  const alongY = water(object.x, object.y - 1) || water(object.x, object.y + 1);
  if (alongX && !alongY) return 'objects/bridge-ne';
  if (alongY && !alongX) return 'objects/bridge-nw';
  return object.direction === 'NE-SW' ? 'objects/bridge-ne' : 'objects/bridge-nw';
}

const OBJECT_ART: Record<Exclude<BattleObject['kind'], 'bridge'>, string> = {
  'fort-small': 'objects/fort-1',
  'fort-medium': 'objects/fort-2',
  'fort-large': 'objects/fort-3',
  // 관문 그림이 아직 없어 큰 성채 그림을 빌린다.
  gate: 'objects/fort-3',
  camp: 'objects/camp',
  village: 'objects/village',
  earthwork: 'objects/mound',
  rubble: 'objects/ruin',
};

export const OBJECT_LABEL: Record<BattleObject['kind'] | 'supply', string> = {
  bridge: '다리',
  'fort-small': '작은 성채',
  'fort-medium': '중간 성채',
  'fort-large': '큰 성채',
  gate: '관문',
  camp: '진영',
  village: '마을',
  earthwork: '흙더미',
  rubble: '무너진 터',
  supply: '보급 거점',
};

export interface PlacedObject {
  x: number;
  y: number;
  kind: BattleObject['kind'] | 'supply';
  /** 그림 이름(battle/ 아래, 확장자 없음) */
  art: string;
}

/**
 * 칸마다 세울 지물. 판의 고정 지물이 먼저이고, 지물이 없는 거점 칸에는 거점 지물(기본 진영, 보급 거점은 보급 그림)을 세운다.
 */
export function placedObjects(board: BattleBoardData, bases: readonly BattleBase[]): PlacedObject[] {
  const byCell = new Map<string, PlacedObject>();
  for (const object of board.objects ?? []) {
    const art = object.kind === 'bridge' ? bridgeArtName(board, object) : OBJECT_ART[object.kind];
    byCell.set(cellKey(object.x, object.y), { x: object.x, y: object.y, kind: object.kind, art });
  }
  for (const base of bases) {
    const key = cellKey(base.x, base.y);
    if (byCell.has(key)) continue;
    const kind = base.kind === 'supply' ? 'supply' : (base.structure ?? 'camp');
    byCell.set(key, { x: base.x, y: base.y, kind, art: kind === 'supply' ? 'objects/supply' : OBJECT_ART[kind] });
  }
  return [...byCell.values()];
}

/** 직접 지휘 때 고른 내 부대가 칠 수 있는 적 칸(이웃 8칸). */
export function attackCells(units: readonly BattleUnit[], unit: BattleUnit | null): Set<string> {
  const out = new Set<string>();
  if (!unit) return out;
  for (const other of units)
    if (
      other.side !== unit.side &&
      other.status !== 'routed' &&
      Math.max(Math.abs(other.x - unit.x), Math.abs(other.y - unit.y)) === 1
    )
      out.add(cellKey(other.x, other.y));
  return out;
}

/** 시야 계산(시험과 미리보기용). 부대는 vision(없으면 3), 소유 거점은 2칸, 체비셰프 거리. 서버가 보낸 visibleCells가 우선이다. */
export function visionCells(
  board: BattleBoardData,
  units: readonly BattleUnit[],
  bases: readonly BattleBase[],
  side: BattleUnit['side'],
): BattleCell[] {
  const eyes = [
    ...units.filter((unit) => unit.side === side && unit.status !== 'routed').map((u) => [u.x, u.y, u.vision ?? 3]),
    ...bases.filter((base) => base.owner === side).map((b) => [b.x, b.y, 2]),
  ];
  const out: BattleCell[] = [];
  for (let y = 0; y < board.height; y++)
    for (let x = 0; x < board.width; x++)
      if (eyes.some(([ex, ey, r]) => Math.max(Math.abs(ex! - x), Math.abs(ey! - y)) <= r!)) out.push({ x, y });
  return out;
}
