import type { PublicGeography } from '@opensamguk/shared';
import { palette } from './pixel-basemap.json';
import { ROAD_CELL, routePoints, routeSiteIds } from './roadPixels';

// 확대 지형 타일 (INT-20, D-047). 도트 바탕의 한 픽셀(2단위 칸)이 화면에서 충분히 커지면
// 그 칸의 지형 종류에 맞는 타일 그림으로 바꿔 그린다. 길은 칸끼리 상하좌우로 이은 연결 모양 타일이다.

type Point = { x: number; y: number };
export type View = { x: number; y: number; width: number; height: number };
export type Terrain = keyof typeof palette;

export const TERRAINS = Object.keys(palette) as Terrain[];
// 칸 한 변이 화면에서 이만큼(px) 이상이면 타일로 그린다.
export const TILE_FROM_PX = 12;

const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('');
export type TerrainPalette = Record<Terrain, string>;
const colorIndex = (colors: TerrainPalette) => new Map(TERRAINS.map((name, index) => [colors[name], index]));
const byColor = colorIndex(palette);

export function showTiles(pixelsPerUnit: number) {
  return pixelsPerUnit * ROAD_CELL >= TILE_FROM_PX;
}

// RGBA 픽셀을 지형 번호로 읽는다. 지도 판마다 표시 색이 달라 그 판의 색 판으로 읽는다. 색 판 밖 색은 -1이다.
export function terrainGrid(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  colors: TerrainPalette = palette,
): Int8Array {
  const lookup = colors === palette ? byColor : colorIndex(colors);
  const grid = new Int8Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4;
    grid[index] = lookup.get(hex(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!)) ?? -1;
  }
  return grid;
}

// 보이는 칸 범위. 가장자리 칸은 반쯤 보여도 넣는다.
export function visibleCells(view: View, columns: number, rows: number) {
  return {
    left: Math.max(0, Math.floor(view.x / ROAD_CELL)),
    top: Math.max(0, Math.floor(view.y / ROAD_CELL)),
    right: Math.min(columns - 1, Math.ceil((view.x + view.width) / ROAD_CELL) - 1),
    bottom: Math.min(rows - 1, Math.ceil((view.y + view.height) / ROAD_CELL) - 1),
  };
}

// 보이는 칸을 지형별 path로 묶는다. 같은 줄에서 이어진 같은 지형은 한 사각형이다.
export function terrainPaths(grid: Int8Array, columns: number, rows: number, view: View) {
  const { left, top, right, bottom } = visibleCells(view, columns, rows);
  const parts = TERRAINS.map(() => [] as string[]);
  for (let y = top; y <= bottom; y += 1) {
    let start = left;
    for (let x = left + 1; x <= right + 1; x += 1) {
      const kind = grid[y * columns + start]!;
      if (x <= right && grid[y * columns + x] === kind) continue;
      if (kind >= 0) {
        const run = (x - start) * ROAD_CELL;
        parts[kind]!.push(`M${start * ROAD_CELL} ${y * ROAD_CELL}h${run}v${ROAD_CELL}h${-run}z`);
      }
      start = x;
    }
  }
  return TERRAINS.map((terrain, index) => ({ terrain, d: parts[index]!.join('') })).filter((part) => part.d);
}

// 길 연결 비트: 북 1, 동 2, 남 4, 서 8.
export const NORTH = 1;
export const EAST = 2;
export const SOUTH = 4;
export const WEST = 8;

// 점과 점 사이를 상하좌우로만 움직이는 칸 길로 잇는다. 대각선 걸음은 가로 칸을 하나 끼운다.
export function walk(points: readonly Point[], cell = ROAD_CELL): Point[] {
  const out: Point[] = [];
  const toCell = (point: Point) => ({ x: Math.floor(point.x / cell), y: Math.floor(point.y / cell) });
  for (let index = 0; index < points.length; index += 1) {
    const end = toCell(points[index]!);
    if (index === 0) {
      out.push(end);
      continue;
    }
    let { x, y } = toCell(points[index - 1]!);
    const dx = Math.abs(end.x - x);
    const dy = -Math.abs(end.y - y);
    const sx = x < end.x ? 1 : -1;
    const sy = y < end.y ? 1 : -1;
    let error = dx + dy;
    while (x !== end.x || y !== end.y) {
      const twice = 2 * error;
      const stepX = twice >= dy;
      const stepY = twice <= dx;
      if (stepX) {
        error += dy;
        x += sx;
        out.push({ x, y });
      }
      if (stepY) {
        error += dx;
        y += sy;
        out.push({ x, y });
      }
    }
  }
  return out;
}

// 거점 문 (INT-20). 길은 거점 표식의 동서남북 문으로만 드나든다. 상대 점 쪽으로 더 많이 벌어진 축의 문을 쓰고,
// 문 칸에서 바깥으로 한 칸 곧게 나간 뒤 다음 점으로 잇는다. 거점 안쪽 칸은 표식에 가려진다.
type Gate = { dx: number; dy: number };
const gateToward = (from: Point, to: Point): Gate =>
  Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
    ? { dx: Math.sign(to.x - from.x) || 1, dy: 0 }
    : { dx: 0, dy: Math.sign(to.y - from.y) };
const spur = (center: Point, gate: Gate, length: number) =>
  Array.from({ length: length + 1 }, (_, step) => ({ x: center.x + gate.dx * step, y: center.y + gate.dy * step }));

// 두 문 밖 칸 사이를 가로세로 곧은 줄로 잇는다. 문 방향이 같은 축이면 가운데에서 한 번 비켜 가고(ㄹ자),
// 다른 축이면 한 번만 꺾는다(ㄱ자). 계단식 대각선을 만들지 않는다.
function straightRuns(from: Point, leave: Gate, to: Point, enter: Gate): Point[] {
  const corners: Point[] = [from];
  if (leave.dx && enter.dx) {
    const mid = Math.round((from.x + to.x) / 2);
    corners.push({ x: mid, y: from.y }, { x: mid, y: to.y });
  } else if (leave.dy && enter.dy) {
    const mid = Math.round((from.y + to.y) / 2);
    corners.push({ x: from.x, y: mid }, { x: to.x, y: mid });
  } else if (leave.dx) corners.push({ x: to.x, y: from.y });
  else corners.push({ x: from.x, y: to.y });
  corners.push(to);
  const out: Point[] = [];
  for (let index = 1; index < corners.length; index += 1) {
    const a = corners[index - 1]!;
    const b = corners[index]!;
    const steps = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    for (let step = 1; step <= steps; step += 1)
      out.push({ x: a.x + Math.sign(b.x - a.x) * step, y: a.y + Math.sign(b.y - a.y) * step });
  }
  return out;
}

// gateCells: 거점 중심에서 문 칸까지의 칸 수(표식 반지름). 0이면 문 없이 중심끼리 잇는다.
export function gatedWalk(points: readonly Point[], gateCells: readonly number[], cell = ROAD_CELL): Point[] {
  const centers = points.map((point) => ({ x: Math.floor(point.x / cell), y: Math.floor(point.y / cell) }));
  const out: Point[] = [];
  for (let index = 1; index < centers.length; index += 1) {
    const from = centers[index - 1]!;
    const to = centers[index]!;
    const leave = gateToward(from, to);
    const enter = gateToward(to, from);
    const outbound = spur(from, leave, gateCells[index - 1]! + 1);
    const inbound = spur(to, enter, gateCells[index]! + 1).reverse();
    const middle = straightRuns(outbound.at(-1)!, leave, inbound[0]!, enter);
    for (const part of [outbound, middle, inbound])
      for (const point of part)
        if (!out.length || out.at(-1)!.x !== point.x || out.at(-1)!.y !== point.y) out.push(point);
  }
  return out.length ? out : centers.slice(0, 1);
}

// 땅길·다리의 칸별 연결 모양. 여울·물길과 물길로 따로 그리는 경로(skip)는 뺀다.
export function roadTiles(
  map: Pick<PublicGeography, 'sites' | 'routes'>,
  skip: ReadonlySet<string> = new Set(),
  gateCells: (siteId: string) => number = () => 0,
  cell = ROAD_CELL,
) {
  const siteById = new Map(map.sites.map((site) => [site.id, site]));
  const masks = new Map<string, { x: number; y: number; mask: number }>();
  const at = (point: Point) => {
    const key = `${point.x},${point.y}`;
    let tile = masks.get(key);
    if (!tile) masks.set(key, (tile = { ...point, mask: 0 }));
    return tile;
  };
  for (const route of map.routes) {
    if (!route.enabled || skip.has(route.id) || (route.mode !== 'LAND' && route.mode !== 'BRIDGE')) continue;
    const points = routePoints(route, siteById);
    if (!points) continue;
    const cells = gatedWalk(points, routeSiteIds(route).map(gateCells), cell);
    at(cells[0]!);
    for (let index = 1; index < cells.length; index += 1) {
      const from = at(cells[index - 1]!);
      const to = at(cells[index]!);
      if (to.x > from.x) [from.mask, to.mask] = [from.mask | EAST, to.mask | WEST];
      else if (to.x < from.x) [from.mask, to.mask] = [from.mask | WEST, to.mask | EAST];
      else if (to.y > from.y) [from.mask, to.mask] = [from.mask | SOUTH, to.mask | NORTH];
      else if (to.y < from.y) [from.mask, to.mask] = [from.mask | NORTH, to.mask | SOUTH];
    }
  }
  return [...masks.values()];
}

// 물길 표시 (INT-20, 화면만). 지도 자료의 땅길 가운데 물 위를 지나는 경로를 바다·강 칸을 따라 그린다.
// 이동 규칙과 경로 종류는 바꾸지 않는다.
const WATER = new Set<Terrain>(['deepSea', 'sea', 'shallow', 'lake', 'river']);
const SEA = new Set<Terrain>(['deepSea', 'sea', 'shallow']);
const waterIndex = new Set(TERRAINS.flatMap((name, index) => (WATER.has(name) ? [index] : [])));
// 지형 번호 가운데 물. 길이 지나면 다리를 놓는다.
export const WATER_TERRAINS: ReadonlySet<number> = waterIndex;
const seaIndex = new Set(TERRAINS.flatMap((name, index) => (SEA.has(name) ? [index] : [])));
// 끝점 둘레 이 칸 수 안의 땅은 물길이 지나갈 수 있다(항구에서 배에 오르는 자리).
const LANDING = 3;

type Grid = { cells: Int8Array; columns: number; rows: number };

export function isWaterRoute(cells: readonly Point[], grid: Grid) {
  let water = 0;
  let sea = 0;
  for (const { x, y } of cells) {
    const kind = grid.cells[y * grid.columns + x] ?? -1;
    if (waterIndex.has(kind)) water += 1;
    if (seaIndex.has(kind)) sea += 1;
  }
  return sea / cells.length >= 0.15 || water / cells.length >= 0.5;
}

// 물 칸과 끝점 둘레를 지나는 상하좌우 최단 칸 길(너비 우선). 길이 없으면 null이다.
export function waterPath(from: Point, to: Point, grid: Grid): Point[] | null {
  const { columns, rows, cells } = grid;
  const near = (x: number, y: number, point: Point) =>
    Math.abs(x - point.x) <= LANDING && Math.abs(y - point.y) <= LANDING;
  const open = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < columns &&
    y < rows &&
    (waterIndex.has(cells[y * columns + x]!) || near(x, y, from) || near(x, y, to));
  // 지도 끝 좌표(예: 1000,700)는 격자 밖 칸이 된다. 시작·목표가 격자 안이 아니면 물길이 없다.
  const inGrid = (point: Point) => point.x >= 0 && point.y >= 0 && point.x < columns && point.y < rows;
  if (!inGrid(from) || !inGrid(to)) return null;
  const previous = new Int32Array(columns * rows).fill(-1);
  const start = from.y * columns + from.x;
  const goal = to.y * columns + to.x;
  previous[start] = start;
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head]!;
    if (at === goal) break;
    const x = at % columns;
    const y = (at - x) / columns;
    for (const [nx, ny] of [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ] as const) {
      const next = ny * columns + nx;
      if (!open(nx, ny) || previous[next] !== -1) continue;
      previous[next] = at;
      queue.push(next);
    }
  }
  if (previous[goal] === -1) return null;
  const path: Point[] = [];
  for (let at = goal; ; at = previous[at]!) {
    path.push({ x: at % columns, y: Math.floor(at / columns) });
    if (at === start) break;
  }
  return path.reverse();
}

// 물길로 그릴 경로와 그 칸. 물길을 못 찾으면 원래 직선 칸을 쓴다.
export function waterLanes(map: Pick<PublicGeography, 'sites' | 'routes'>, grid: Grid, cell = ROAD_CELL) {
  const siteById = new Map(map.sites.map((site) => [site.id, site]));
  const lanes: { id: string; cells: Point[] }[] = [];
  for (const route of map.routes) {
    if (!route.enabled || (route.mode !== 'LAND' && route.mode !== 'BRIDGE')) continue;
    const points = routePoints(route, siteById);
    if (!points) continue;
    const straight = walk(points, cell);
    if (!isWaterRoute(straight, grid)) continue;
    const ends = points.map((point) => ({ x: Math.floor(point.x / cell), y: Math.floor(point.y / cell) }));
    const legs = ends.slice(1).map((end, index) => waterPath(ends[index]!, end, grid));
    lanes.push({ id: route.id, cells: legs.every(Boolean) ? legs.flatMap((leg) => leg!) : straight });
  }
  return lanes;
}

// 강둑 (INT-20). 보이는 강·호수 칸 가운데 땅과 맞닿은 칸과 그 땅 쪽 비트.
export function bankTiles(grid: Grid, view: View) {
  const { left, top, right, bottom } = visibleCells(view, grid.columns, grid.rows);
  const inland = new Set([TERRAINS.indexOf('river'), TERRAINS.indexOf('lake')]);
  const land = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= grid.columns || y >= grid.rows) return false;
    const kind = grid.cells[y * grid.columns + x]!;
    return kind >= 0 && !waterIndex.has(kind);
  };
  const out: { x: number; y: number; mask: number }[] = [];
  for (let y = top; y <= bottom; y += 1)
    for (let x = left; x <= right; x += 1) {
      if (!inland.has(grid.cells[y * grid.columns + x]!)) continue;
      const mask =
        (land(x, y - 1) ? NORTH : 0) |
        (land(x + 1, y) ? EAST : 0) |
        (land(x, y + 1) ? SOUTH : 0) |
        (land(x - 1, y) ? WEST : 0);
      if (mask) out.push({ x, y, mask });
    }
  return out;
}

// 산 높이 (INT-20). 구릉 1, 산 2, 고산 3단이다. 북쪽·서쪽 이웃이 더 높으면 그 차이만큼 그림자를 드리운다.
const HEIGHT: Partial<Record<Terrain, number>> = { hills: 1, mountains: 2, highMountains: 3 };
const heightOf = TERRAINS.map((name) => HEIGHT[name] ?? 0);

export function shadowPaths(grid: Grid, view: View, cell = ROAD_CELL) {
  const { left, top, right, bottom } = visibleCells(view, grid.columns, grid.rows);
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= grid.columns || y >= grid.rows ? 0 : (heightOf[grid.cells[y * grid.columns + x]!] ?? 0);
  const levels = [[], [], []] as string[][];
  for (let y = top; y <= bottom; y += 1)
    for (let x = left; x <= right; x += 1) {
      const here = at(x, y);
      const north = at(x, y - 1) - here;
      const west = at(x - 1, y) - here;
      // 높이 차이 1단마다 칸의 1/3씩 그림자가 길어진다(3단이면 한 칸 전체).
      if (north > 0) levels[north - 1]!.push(`M${x * cell} ${y * cell}h${cell}v${(cell * north) / 3}h${-cell}z`);
      if (west > 0)
        levels[west - 1]!.push(`M${x * cell} ${y * cell}h${(cell * west) / 3}v${cell}h${-(cell * west) / 3}z`);
    }
  return levels.map((parts, index) => ({ step: index + 1, d: parts.join('') })).filter((level) => level.d);
}
