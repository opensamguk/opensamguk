import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SKETCH, SKETCH_PALETTE, type MapV2 } from './contract';
import { testMap } from './fixtures';
import { encodeSketchPng, rasterizeSketch } from './sketch';

// T4-80 밑그림. 크기는 캔버스의 3배이고 화소는 다섯 색 번호뿐이다.
const terrainMap = (): MapV2 => ({
  ...testMap(),
  terrain: {
    coast: [
      [
        [0, 0],
        [400, 0],
        [400, 400],
        [0, 400],
        [0, 0],
      ],
    ],
    mountains: [
      [
        [100, 100],
        [300, 100],
        [300, 300],
        [100, 300],
        [100, 100],
      ],
    ],
    lakes: [
      [
        [150, 150],
        [250, 150],
        [250, 250],
        [150, 250],
        [150, 150],
      ],
    ],
    rivers: [
      {
        points: [
          [0, 450],
          [700, 450],
        ],
      },
    ],
  },
});

const at = (raster: ReturnType<typeof rasterizeSketch>, x: number, y: number) =>
  raster.data[Math.floor(y * 3) * raster.width + Math.floor(x * 3)];

// 2100×1500 화소를 칠하므로 부하가 큰 기계에서는 기본 5초를 넘길 수 있다.
const SLOW = 30_000;

describe('래스터', { timeout: SLOW }, () => {
  it('2100×1500이고 색 번호 0~4만 쓴다', () => {
    const raster = rasterizeSketch(terrainMap());
    expect([raster.width, raster.height]).toEqual([2100, 1500]);
    expect(raster.data).toHaveLength(2100 * 1500);
    expect(new Set(raster.data)).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it('바다 위에 땅, 산, 호수, 강 순서로 칠한다', () => {
    const raster = rasterizeSketch(terrainMap());
    expect(at(raster, 600, 100)).toBe(SKETCH.sea);
    expect(at(raster, 50, 50)).toBe(SKETCH.land);
    expect(at(raster, 120, 120)).toBe(SKETCH.mountain);
    expect(at(raster, 200, 200)).toBe(SKETCH.lake);
    expect(at(raster, 350, 450)).toBe(SKETCH.river);
    expect(at(raster, 350, 452)).toBe(SKETCH.sea);
  });

  it('해안이 없으면 바탕이 땅이다', () => {
    const raster = rasterizeSketch(testMap());
    expect(new Set(raster.data)).toEqual(new Set([SKETCH.land]));
  });

  it('도시는 칠하지 않는다', () => {
    const same = Buffer.from(rasterizeSketch(testMap()).data).equals(
      Buffer.from(rasterizeSketch({ ...testMap(), cities: [] }).data),
    );
    expect(same).toBe(true);
  });
});

function readPng(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = new Map<string, Uint8Array[]>();
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    chunks.set(type, [...(chunks.get(type) ?? []), bytes.subarray(offset + 8, offset + 8 + length)]);
    offset += 12 + length;
  }
  return chunks;
}

describe('PNG', { timeout: SLOW }, () => {
  it('팔레트 PNG이고 팔레트는 5칸, 화소는 래스터와 같다', async () => {
    const raster = rasterizeSketch(terrainMap());
    const png = await encodeSketchPng(raster);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = readPng(png);
    const header = new DataView(chunks.get('IHDR')![0]!.buffer, chunks.get('IHDR')![0]!.byteOffset);
    expect([header.getUint32(0), header.getUint32(4), header.getUint8(8), header.getUint8(9)]).toEqual([
      2100, 1500, 8, 3,
    ]);
    const palette = chunks.get('PLTE')![0]!;
    expect(palette.length).toBe(5 * 3);
    expect(
      SKETCH_PALETTE.map(
        (_, i) => `#${[...palette.subarray(i * 3, i * 3 + 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
      ),
    ).toEqual(SKETCH_PALETTE.map((entry) => entry.color));
    const rows = inflateSync(Buffer.concat(chunks.get('IDAT')!));
    expect(rows.length).toBe(2101 * 1500);
    const pixels = new Uint8Array(2100 * 1500);
    let filters = 0;
    for (let y = 0; y < 1500; y++) {
      filters += rows[y * 2101]!;
      pixels.set(rows.subarray(y * 2101 + 1, (y + 1) * 2101), y * 2100);
    }
    expect(filters).toBe(0);
    // 큰 배열을 toEqual로 견주면 느려서 Buffer로 견준다.
    expect(Buffer.from(pixels).equals(Buffer.from(raster.data))).toBe(true);
  });
});
