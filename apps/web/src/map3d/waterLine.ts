// 수로를 강 가운데로(INT-27, 사용자 2026-11-14: "수로는 만약 강에 있으면 강 안에 수로를 그려").
// 칸 길찾기의 수로 선은 칸 가운데를 이어 강 옆 뭍으로 비껴 나간다. 그림 지도의 정밀 물 지도(painted-water.py
// water-detail.png, 캔버스 한 단위에 한 픽셀)에서 기슭까지 거리를 재고, 선의 점마다 가까운 물길 한가운데로 옮긴다.

export type Point = { x: number; y: number };

/** 정밀 물 지도: 픽셀마다 1 물, 0 뭍. 판 크기는 캔버스 크기와 비율이 같다. */
export type WaterDetail = { data: Uint8Array; width: number; height: number };

/** 물 픽셀마다 가장 가까운 뭍까지 거리(픽셀, 모서리 1·대각 √2 근사). 뭍은 0. */
export function shoreDistance({ data, width, height }: WaterDetail): Float32Array {
  const far = width + height;
  const distance = new Float32Array(width * height);
  for (let i = 0; i < distance.length; i++) distance[i] = data[i] ? far : 0;
  const diagonal = Math.SQRT2;
  const relax = (i: number, j: number, cost: number) => {
    const next = distance[j]! + cost;
    if (next < distance[i]!) distance[i] = next;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!distance[i]) continue;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) {
        relax(i, i - width, 1);
        if (x > 0) relax(i, i - width - 1, diagonal);
        if (x < width - 1) relax(i, i - width + 1, diagonal);
      }
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!distance[i]) continue;
      if (x < width - 1) relax(i, i + 1, 1);
      if (y < height - 1) {
        relax(i, i + width, 1);
        if (x < width - 1) relax(i, i + width + 1, diagonal);
        if (x > 0) relax(i, i + width - 1, diagonal);
      }
    }
  return distance;
}

/**
 * 선을 촘촘히 나눈 뒤 점마다 반지름 안에서 물길 한가운데(기슭에서 가장 먼 곳, 멀리 옮길수록 손해)로 옮긴다.
 * 반지름 안에 물이 없는 점(성이 선 뭍, 운하처럼 그림에 없는 물길)은 그대로 둔다. 첫 점·끝 점은 성 자리라 두지 않는다.
 * scale은 캔버스 한 단위에 해당하는 물 지도 픽셀 수다.
 */
export function snapToChannel(
  line: readonly Point[],
  water: WaterDetail,
  distance: Float32Array,
  scale: number,
  radius = 6,
): Point[] {
  if (line.length < 2) return [...line];
  const { width, height } = water;
  const dense: Point[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * scale));
    for (let k = 0; k < steps; k++)
      dense.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
  }
  dense.push(line[line.length - 1]!);
  const out: Point[] = [dense[0]!];
  for (let i = 1; i < dense.length - 1; i++) {
    const p = dense[i]!;
    const px = Math.round(p.x * scale);
    const py = Math.round(p.y * scale);
    let best = -Infinity;
    let bx = -1;
    let by = -1;
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const depth = distance[y * width + x]!;
        if (!depth) continue;
        const score = Math.min(depth, radius) - 0.35 * Math.hypot(dx, dy);
        if (score > best) {
          best = score;
          bx = x;
          by = y;
        }
      }
    const q = bx < 0 ? p : { x: (bx + 0.5) / scale, y: (by + 0.5) / scale };
    const last = out[out.length - 1]!;
    if (Math.hypot(q.x - last.x, q.y - last.y) > 0.25 / scale) out.push(q);
  }
  out.push(dense[dense.length - 1]!);
  return out;
}
