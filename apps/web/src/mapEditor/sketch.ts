// 지형 층을 5색 도트 밑그림으로 칠한다 (docs/plans/T4-80.md 밑그림 PNG, map-editor.md §4).
// 브라우저 캔버스는 경계를 섞어 다섯 색 밖의 화소를 만든다. 그래서 화소마다 팔레트 번호를 직접 정하고
// 팔레트 PNG(색 형식 3)로 쓴다. 도시 점·이름·연결선은 넣지 않는다.
import { SKETCH, SKETCH_PALETTE, type MapV2, type Point } from './contract';

export const SKETCH_SCALE = 3;
// 강 굵기. 지도 좌표 단위다.
export const RIVER_WIDTH = 2;

export interface SketchRaster {
  width: number;
  height: number;
  // 화소마다 SKETCH_PALETTE 번호 하나
  data: Uint8Array;
}

// 짝홀 규칙 주사선 채우기. 화소 중심이 다각형 안이면 칠한다.
function fillPolygon(raster: SketchRaster, points: readonly Point[], scale: number, color: number) {
  const { width, height, data } = raster;
  if (points.length < 3) return;
  const xs: number[] = [];
  for (let py = 0; py < height; py++) {
    const y = (py + 0.5) / scale;
    xs.length = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i]!;
      const [x2, y2] = points[(i + 1) % points.length]!;
      if (y1 === y2 || y < Math.min(y1, y2) || y >= Math.max(y1, y2)) continue;
      xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k]! * scale - 0.5));
      const to = Math.min(width - 1, Math.ceil(xs[k + 1]! * scale - 0.5) - 1);
      data.fill(color, py * width + from, py * width + to + 1);
    }
  }
}

// 굵은 선. 화소 중심에서 선분까지 거리가 굵기의 절반 이하면 칠한다.
function strokeLine(raster: SketchRaster, points: readonly Point[], scale: number, lineWidth: number, color: number) {
  const { width, height, data } = raster;
  const r = (lineWidth * scale) / 2;
  for (let i = 0; i + 1 < points.length; i++) {
    const ax = points[i]![0] * scale;
    const ay = points[i]![1] * scale;
    const bx = points[i + 1]![0] * scale;
    const by = points[i + 1]![1] * scale;
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + r));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / length2));
        const ex = cx - (ax + t * dx);
        const ey = cy - (ay + t * dy);
        if (ex * ex + ey * ey <= r * r) data[py * width + px] = color;
      }
    }
  }
}

// 해안 다각형이 하나라도 있으면 바탕은 바다이고 해안 안이 땅이다. 해안이 없으면 내륙 지도로 보고 바탕을 땅으로 둔다.
export const sketchBackground = (map: MapV2) => (map.terrain.coast.length > 0 ? SKETCH.sea : SKETCH.land);

export function rasterizeSketch(map: MapV2, scale = SKETCH_SCALE): SketchRaster {
  const width = Math.round(map.canvas.width * scale);
  const height = Math.round(map.canvas.height * scale);
  const raster: SketchRaster = { width, height, data: new Uint8Array(width * height).fill(sketchBackground(map)) };
  for (const polygon of map.terrain.coast) fillPolygon(raster, polygon, scale, SKETCH.land);
  for (const polygon of map.terrain.mountains) fillPolygon(raster, polygon, scale, SKETCH.mountain);
  for (const polygon of map.terrain.lakes) fillPolygon(raster, polygon, scale, SKETCH.lake);
  for (const river of map.terrain.rivers) strokeLine(raster, river.points, scale, RIVER_WIDTH, SKETCH.river);
  return raster;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

// PNG의 IDAT는 zlib 형식이고 CompressionStream('deflate')가 바로 그 형식을 낸다.
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeSketchPng(raster: SketchRaster): Promise<Uint8Array> {
  const { width, height, data } = raster;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // 화소당 8비트 번호
  header[9] = 3; // 팔레트 색
  const palette = new Uint8Array(SKETCH_PALETTE.length * 3);
  SKETCH_PALETTE.forEach(({ color }, i) => {
    for (let k = 0; k < 3; k++) palette[i * 3 + k] = Number.parseInt(color.slice(1 + k * 2, 3 + k * 2), 16);
  });
  // 줄마다 앞에 거르개 0(없음) 한 바이트를 둔다.
  const rows = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) rows.set(data.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('PLTE', palette),
    chunk('IDAT', await deflate(rows)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
