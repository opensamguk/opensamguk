import type { Point, Ring } from './format';

export function isClosedRing(points: Ring): boolean {
  const first = points[0];
  const last = points.at(-1);
  return (
    points.length >= 4 && first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]
  );
}

function onSegment([x, y]: Point, [ax, ay]: Point, [bx, by]: Point): boolean {
  return (
    (x - ax) * (by - ay) === (y - ay) * (bx - ax) &&
    x >= Math.min(ax, bx) &&
    x <= Math.max(ax, bx) &&
    y >= Math.min(ay, by) &&
    y <= Math.max(ay, by)
  );
}

// 여러 고리를 한 번에 세어 겹친 해안도 짝홀 규칙을 따른다. 경계는 안이다.
export function pointInRings(point: Point, rings: readonly Ring[]): boolean {
  let inside = false;
  for (const ring of rings) {
    if (!isClosedRing(ring)) continue;
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1]!;
      const b = ring[i]!;
      if (onSegment(point, a, b)) return true;
      if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0])
        inside = !inside;
    }
  }
  return inside;
}
