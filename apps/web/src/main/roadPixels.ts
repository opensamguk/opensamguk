import type { PublicGeography } from '@opensamguk/shared';

// 도로 픽셀 층 (INT-20, D-047). 도트 바탕 지도(500×350)와 같은 2단위 칸에 경로를 찍어
// 선 대신 칸으로 그린다. 같은 지리 자료에서 늘 같은 칸이 나온다.

type Route = PublicGeography['routes'][number];
type Site = PublicGeography['sites'][number];
type Point = { x: number; y: number };
export type RoadMode = Route['mode'];

export const ROAD_CELL = 2;

// 경로가 지나는 거점. 물길은 양쪽 항구를 거친다.
export function routeSiteIds(route: Route): string[] {
  return [
    route.from,
    ...(route.mode === 'RIVER' && route.portIds ? [route.portIds[0]] : []),
    ...(route.via ?? []),
    ...(route.mode === 'RIVER' && route.portIds ? [route.portIds[1]] : []),
    route.to,
  ];
}

// 경로가 지나는 점.
export function routePoints(route: Route, siteById: ReadonlyMap<string, Pick<Site, 'position'>>): Point[] | null {
  const points = routeSiteIds(route).map((id) => siteById.get(id)?.position);
  return points.every((point) => point !== undefined) ? points : null;
}

// 점과 점 사이를 칸 단위 직선(브레젠험)으로 잇는다. 순서대로 겹치지 않는 칸을 돌려준다.
export function rasterize(points: readonly Point[], cell = ROAD_CELL): Point[] {
  const seen = new Set<string>();
  const out: Point[] = [];
  const put = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, y });
  };
  const toCell = (point: Point) => ({ x: Math.floor(point.x / cell), y: Math.floor(point.y / cell) });
  for (let index = 0; index < points.length; index += 1) {
    const end = toCell(points[index]!);
    if (index === 0) {
      put(end.x, end.y);
      continue;
    }
    let { x, y } = toCell(points[index - 1]!);
    const dx = Math.abs(end.x - x);
    const dy = -Math.abs(end.y - y);
    const sx = x < end.x ? 1 : -1;
    const sy = y < end.y ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      put(x, y);
      if (x === end.x && y === end.y) break;
      const twice = 2 * error;
      if (twice >= dy) {
        error += dy;
        x += sx;
      }
      if (twice <= dx) {
        error += dx;
        y += sy;
      }
    }
  }
  return out;
}

// 여울과 물길은 두 칸 찍고 두 칸 비운다.
export function roadCells(mode: RoadMode, points: readonly Point[], cell = ROAD_CELL): Point[] {
  const cells = rasterize(points, cell);
  return mode === 'FORD' || mode === 'RIVER' ? cells.filter((_, index) => Math.floor(index / 2) % 2 === 0) : cells;
}

// 같은 줄에서 이어진 칸을 한 사각형으로 묶어 SVG path 하나로 만든다.
export function cellsPath(cells: readonly Point[], cell = ROAD_CELL): string {
  const rows = new Map<number, number[]>();
  for (const { x, y } of cells) rows.set(y, [...(rows.get(y) ?? []), x]);
  const parts: string[] = [];
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    const xs = [...new Set(rows.get(y))].sort((a, b) => a - b);
    let start = xs[0]!;
    for (let index = 1; index <= xs.length; index += 1) {
      const x = xs[index];
      if (x === xs[index - 1]! + 1) continue;
      const run = xs[index - 1]! - start + 1;
      parts.push(`M${start * cell} ${y * cell}h${run * cell}v${cell}h${-run * cell}z`);
      if (x !== undefined) start = x;
    }
  }
  return parts.join('');
}

// 지도 전체 도로를 길 종류별 path로 묶는다. 꺼진 경로와 점을 모르는 경로는 뺀다.
export function roadLayer(
  map: Pick<PublicGeography, 'sites' | 'routes'>,
  skip: ReadonlySet<string> = new Set(),
  cell = ROAD_CELL,
) {
  const siteById = new Map(map.sites.map((site) => [site.id, site]));
  const byMode = new Map<RoadMode, Point[]>();
  for (const route of map.routes) {
    if (!route.enabled || skip.has(route.id)) continue;
    const points = routePoints(route, siteById);
    if (!points) continue;
    byMode.set(route.mode, [...(byMode.get(route.mode) ?? []), ...roadCells(route.mode, points, cell)]);
  }
  return [...byMode].map(([mode, cells]) => ({ mode, d: cellsPath(cells, cell) }));
}

// 관문 방향을 정할 이웃 점: 관문에 닿은 땅길의 바로 다음 점.
export function passNeighbours(siteId: string, map: Pick<PublicGeography, 'sites' | 'routes'>): Point[] {
  const siteById = new Map(map.sites.map((site) => [site.id, site]));
  return map.routes.flatMap((route) => {
    if (!route.enabled || route.mode === 'RIVER') return [];
    const points = routePoints(route, siteById);
    if (!points || points.length < 2) return [];
    if (route.from === siteId) return [points[1]!];
    if (route.to === siteId) return [points[points.length - 2]!];
    return [];
  });
}
