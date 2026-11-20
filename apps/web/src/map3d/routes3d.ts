// 3D 군략도의 길·강·행군 경로 자료 (INT-27). 그리기와 떨어진 순수 계산만 둔다.
import type { PublicGeography } from '@opensamguk/shared';
import { ROAD_CELL } from '../main/roadPixels';

type Point = { x: number; y: number };
type Route = PublicGeography['routes'][number];

/** 칸 길(roadWalks·waterLanes의 칸)을 지도 좌표의 점으로. 칸 가운데를 지난다. */
export function cellsToPoints(cells: readonly Point[], cell = ROAD_CELL): Point[] {
  return cells.map((point) => ({ x: (point.x + 0.5) * cell, y: (point.y + 0.5) * cell }));
}

/** 같은 방향으로 이어지는 점을 덜어 꺾이는 곳만 남긴다. 띠 꼭짓점 수를 줄인다. */
export function simplify(points: readonly Point[]): Point[] {
  if (points.length < 3) return [...points];
  const out = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(points[points.length - 1]!);
  return out;
}

/**
 * Natural Earth 강 경로 문자열(`M x,y L x,y` 조각)을 이어진 선들로 묶는다.
 * 앞 조각의 끝과 다음 조각의 시작이 같으면 한 선으로 잇는다.
 */
export function riverLines(path: string): Point[][] {
  const lines: Point[][] = [];
  const pattern = /M\s*(-?[\d.]+)[ ,](-?[\d.]+)\s*L\s*(-?[\d.]+)[ ,](-?[\d.]+)/g;
  for (const match of path.matchAll(pattern)) {
    const from = { x: Number(match[1]), y: Number(match[2]) };
    const to = { x: Number(match[3]), y: Number(match[4]) };
    const last = lines[lines.length - 1];
    const end = last?.[last.length - 1];
    if (last && end && Math.abs(end.x - from.x) < 1e-6 && Math.abs(end.y - from.y) < 1e-6) last.push(to);
    else lines.push([from, to]);
  }
  return lines;
}

/**
 * 거점 사이 가장 적은 길 수의 경로. 켜진 길만 쓰고 한 방향 길은 방향을 지킨다.
 * 돌려주는 것은 지나는 길과 그 길을 거꾸로 가는지다. 닿지 못하면 null.
 */
export function routePath(
  routes: readonly Route[],
  fromSite: string,
  toSite: string,
): Array<{ route: Route; reverse: boolean }> | null {
  if (fromSite === toSite) return [];
  const edges = new Map<string, Array<{ route: Route; reverse: boolean; next: string }>>();
  const add = (at: string, edge: { route: Route; reverse: boolean; next: string }) => {
    const list = edges.get(at) ?? [];
    list.push(edge);
    edges.set(at, list);
  };
  for (const route of routes) {
    if (!route.enabled) continue;
    add(route.from, { route, reverse: false, next: route.to });
    if (route.direction === 'BOTH') add(route.to, { route, reverse: true, next: route.from });
  }
  const previous = new Map<string, { at: string; route: Route; reverse: boolean }>();
  const queue = [fromSite];
  const seen = new Set(queue);
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    for (const edge of edges.get(at) ?? []) {
      if (seen.has(edge.next)) continue;
      seen.add(edge.next);
      previous.set(edge.next, { at, route: edge.route, reverse: edge.reverse });
      if (edge.next === toSite) {
        const path: Array<{ route: Route; reverse: boolean }> = [];
        let cursor = toSite;
        while (cursor !== fromSite) {
          const step = previous.get(cursor)!;
          path.unshift({ route: step.route, reverse: step.reverse });
          cursor = step.at;
        }
        return path;
      }
      queue.push(edge.next);
    }
  }
  return null;
}

/** 길별 점 목록으로 경로 전체의 점을 잇는다. 길 점이 없으면 두 거점을 곧게 잇는다. */
export function pathPoints(
  path: ReadonlyArray<{ route: Route; reverse: boolean }>,
  lines: ReadonlyMap<string, readonly Point[]>,
  siteAt: (id: string) => Point | undefined,
): Point[] {
  const points: Point[] = [];
  for (const { route, reverse } of path) {
    const line = lines.get(route.id);
    const from = siteAt(reverse ? route.to : route.from);
    const to = siteAt(reverse ? route.from : route.to);
    const leg = line && line.length > 1 ? (reverse ? [...line].reverse() : [...line]) : from && to ? [from, to] : [];
    for (const point of leg) {
      const last = points[points.length - 1];
      if (!last || last.x !== point.x || last.y !== point.y) points.push(point);
    }
  }
  return points;
}

/** 선을 점선 조각들로 자른다(dash 길이, gap 간격, 지도 단위). 물길 점선에 쓴다. */
export function dashLine(points: readonly Point[], dash: number, gap: number): Point[][] {
  const pieces: Point[][] = [];
  let current: Point[] = [];
  let drawing = true;
  let left = dash;
  for (let i = 1; i < points.length; i++) {
    let a = points[i - 1]!;
    const b = points[i]!;
    let length = Math.hypot(b.x - a.x, b.y - a.y);
    while (length > 0) {
      const take = Math.min(left, length);
      const t = take / length;
      const next = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (drawing) {
        if (!current.length) current.push(a);
        current.push(next);
      }
      left -= take;
      length -= take;
      a = next;
      if (left <= 1e-9) {
        if (drawing && current.length > 1) pieces.push(current);
        current = [];
        drawing = !drawing;
        left = drawing ? dash : gap;
      }
    }
  }
  if (drawing && current.length > 1) pieces.push(current);
  return pieces;
}

/** 점 목록 위의 거리 비율 t(0~1) 위치와 진행 방향(라디안). */
export function along(points: readonly Point[], t: number): { x: number; y: number; angle: number } {
  if (points.length === 0) return { x: 0, y: 0, angle: 0 };
  if (points.length === 1) return { ...points[0]!, angle: 0 };
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    lengths.push(length);
    total += length;
  }
  let distance = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!;
    if (distance <= length || i === lengths.length - 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const k = length ? Math.min(distance / length, 1) : 0;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    distance -= length;
  }
  const last = points[points.length - 1]!;
  return { ...last, angle: 0 };
}
