// 길 굽기(INT-27, 사용자 2026-11-14: "길도 구워서 만들던지", "성의있게. 현대식으로 만들지 말고").
// 길 그물 토막을 그림 지도 위에 붓으로 칠하듯 그린다. 일정한 폭의 선 대신 흙빛 가장자리가 번지고, 대로는 바퀴에 닳은
// 밝은 가운데 줄, 소로는 풀이 덮어 군데군데 옅어진다. 그림 지도와 같은 판에 구워서 지도 그림처럼 보인다.
import type { RoadSegment } from './roadNetwork';

type Point = { x: number; y: number };

function trace(ctx: CanvasRenderingContext2D, points: readonly Point[]) {
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  const last = points[points.length - 1]!;
  ctx.lineTo(last.x, last.y);
}

/**
 * ctx(그림 지도 픽셀)에 길을 칠한다. toPx는 캔버스 좌표 → 그림 픽셀, unit은 캔버스 한 단위의 픽셀 수다.
 */
export function paintRoads(
  ctx: CanvasRenderingContext2D,
  segments: readonly RoadSegment[],
  toPx: (point: Point) => Point,
  unit: number,
  bridges: ReadonlyArray<{ x: number; y: number; angle: number; length: number }> = [],
  ferries: ReadonlyArray<readonly Point[]> = [],
  waterRoutes: ReadonlyArray<{ sea: boolean; points: readonly Point[] }> = [],
) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const lines = segments.map((segment) => ({ major: segment.major, points: segment.points.map(toPx) }));
  // 1. 길섶: 흙빛이 바깥으로 번진다(어두운 테두리 대신).
  ctx.filter = `blur(${Math.max(0.6, unit * 0.12)}px)`;
  for (const { major, points } of lines) {
    if (points.length < 2) continue;
    ctx.strokeStyle = major ? 'rgba(96, 72, 42, 0.55)' : 'rgba(96, 76, 48, 0.45)';
    ctx.lineWidth = (major ? 1.7 : 1.15) * unit;
    trace(ctx, points);
    ctx.stroke();
  }
  ctx.filter = 'none';
  // 2. 길바닥: 다진 흙.
  for (const { major, points } of lines) {
    if (points.length < 2) continue;
    ctx.strokeStyle = major ? 'rgba(214, 190, 142, 0.96)' : 'rgba(198, 170, 122, 0.9)';
    ctx.lineWidth = (major ? 1.1 : 0.72) * unit;
    trace(ctx, points);
    ctx.stroke();
  }
  // 3. 결: 대로는 바퀴에 닳은 밝은 가운데, 소로는 풀이 덮어 군데군데 어둡다.
  for (const { major, points } of lines) {
    if (points.length < 2) continue;
    ctx.setLineDash(major ? [unit * 1.4, unit * 0.9] : [unit * 0.7, unit * 1.6]);
    ctx.strokeStyle = major ? 'rgba(238, 222, 184, 0.38)' : 'rgba(120, 128, 72, 0.28)';
    ctx.lineWidth = (major ? 0.4 : 0.5) * unit;
    trace(ctx, points);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // 4. 수로·해로: 물 위의 뱃길 점선. 수로는 옅은 물빛, 해로는 흰빛이고 가장자리가 물에 번진다.
  for (const { sea, points: line } of waterRoutes) {
    const points = line.map(toPx);
    if (points.length < 2) continue;
    ctx.setLineDash([unit * 1.1, unit * 0.9]);
    ctx.filter = `blur(${Math.max(0.5, unit * 0.08)}px)`;
    ctx.strokeStyle = sea ? 'rgba(250, 246, 232, 0.8)' : 'rgba(214, 238, 238, 0.85)';
    ctx.lineWidth = (sea ? 0.42 : 0.36) * unit;
    trace(ctx, points);
    ctx.stroke();
    ctx.filter = 'none';
  }
  ctx.setLineDash([]);
  // 나룻배 길: 육로가 물을 길게 건너는 구간은 길 대신 흰 점선(뱃길)으로.
  for (const ferry of ferries) {
    const points = ferry.map(toPx);
    if (points.length < 2) continue;
    ctx.setLineDash([unit * 0.8, unit * 0.7]);
    ctx.strokeStyle = 'rgba(246, 240, 222, 0.85)';
    ctx.lineWidth = 0.32 * unit;
    trace(ctx, points);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // 5. 나무다리: 길 방향으로 판자를 깔고 양쪽 난간과 끝 기둥을 세운다.
  for (const bridge of bridges) {
    const centre = toPx(bridge);
    const length = bridge.length * unit;
    const width = 0.95 * unit;
    ctx.save();
    ctx.translate(centre.x, centre.y);
    ctx.rotate(bridge.angle);
    ctx.fillStyle = 'rgba(40, 30, 20, 0.35)';
    ctx.fillRect(-length / 2 + unit * 0.12, -width / 2 + unit * 0.18, length, width);
    ctx.fillStyle = '#8b6138';
    ctx.fillRect(-length / 2, -width / 2, length, width);
    ctx.strokeStyle = 'rgba(58, 38, 22, 0.75)';
    ctx.lineWidth = Math.max(1, unit * 0.06);
    for (let x = -length / 2 + unit * 0.22; x < length / 2; x += unit * 0.26) {
      ctx.beginPath();
      ctx.moveTo(x, -width / 2);
      ctx.lineTo(x, width / 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#5a3a20';
    ctx.fillRect(-length / 2, -width / 2 - unit * 0.08, length, unit * 0.12);
    ctx.fillRect(-length / 2, width / 2 - unit * 0.04, length, unit * 0.12);
    for (const end of [-length / 2, length / 2 - unit * 0.18])
      for (const side of [-width / 2 - unit * 0.12, width / 2 - unit * 0.06])
        ctx.fillRect(end, side, unit * 0.18, unit * 0.18);
    ctx.restore();
  }
  ctx.restore();
}
