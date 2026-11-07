import { createHash } from 'node:crypto';
import { constants } from 'node:buffer';
import { crc32, inflateSync } from 'node:zlib';

export interface SketchRaster {
  width: number;
  height: number;
  data: Uint8Array;
}

// 편집기의 팔레트 순서와 같다. PNG 압축 방식은 래스터 해시에 넣지 않는다.
const palette = Buffer.from('2b5d8ccbb98a4f8fd07a63476aa6d8', 'hex');
const { sea, land, river, mountain, lake } = { sea: 0, land: 1, river: 2, mountain: 3, lake: 4 };
const layerPriority = [river, lake, mountain, land, sea];
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function invalid(reason: string): never {
  throw new Error(`밑그림 형식이 맞지 않습니다: ${reason}`);
}

function dimensions(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 0xffff_ffff ||
    height > 0xffff_ffff ||
    !Number.isSafeInteger((width + 1) * height) ||
    (width + 1) * height > constants.MAX_LENGTH
  )
    invalid('크기');
}

/** 편집기가 내보낸 8비트·5색·필터 0 PNG만 읽는다. */
export function readSketchPng(png: Uint8Array, expected: { width: number; height: number }): SketchRaster {
  const { width, height } = expected;
  dimensions(width, height);
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!bytes.subarray(0, 8).equals(signature)) invalid('PNG 서명');
  let phase: 'header' | 'palette' | 'data' | 'end' = 'header';
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (bytes.length - offset < 12) invalid('잘린 청크');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) invalid('청크 길이');
    const end = offset + length + 12;
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid('CRC');
    switch (type) {
      case 'IHDR':
        if (phase !== 'header' || length !== 13) invalid('IHDR 순서·길이');
        if (body.readUInt32BE(0) !== width || body.readUInt32BE(4) !== height) invalid('크기');
        if (!body.subarray(8).equals(Buffer.from([8, 3, 0, 0, 0]))) invalid('IHDR 부호화');
        phase = 'palette';
        break;
      case 'PLTE':
        if (phase !== 'palette' || !body.equals(palette)) invalid('팔레트');
        phase = 'data';
        break;
      case 'IDAT':
        if (phase !== 'data') invalid('IDAT 순서');
        compressed.push(body);
        break;
      case 'IEND':
        if (phase !== 'data' || compressed.length === 0 || length !== 0 || end !== bytes.length) invalid('IEND');
        phase = 'end';
        break;
      default:
        invalid('허용하지 않는 청크');
    }
    offset = end;
  }
  if (phase !== 'end') invalid('IEND 누락');
  const size = (width + 1) * height;
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: size });
  } catch {
    invalid('압축 데이터');
  }
  if (decoded.length !== size) invalid('화소 길이');
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const offset = y * (width + 1);
    if (decoded[offset] !== 0) invalid('행 필터');
    const row = decoded.subarray(offset + 1, offset + width + 1);
    if (row.some((value) => value > 4)) invalid('팔레트 번호');
    data.set(row, y * width);
  }
  return { width, height, data };
}

function assertSketchRaster({ width, height, data }: SketchRaster) {
  dimensions(width, height);
  if (data.length !== width * height || data.some((value) => value > 4)) invalid('화소');
}

export function sketchRasterHash(raster: SketchRaster): string {
  assertSketchRaster(raster);
  const { width, height, data } = raster;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  return createHash('sha256').update(header).update(palette).update(data).digest('hex');
}

export function reduceSketchRaster(raster: SketchRaster, pixelSize: number): SketchRaster {
  assertSketchRaster(raster);
  if (!Number.isInteger(pixelSize) || pixelSize < 1 || raster.width % pixelSize || raster.height % pixelSize)
    invalid('격자 크기');
  const width = raster.width / pixelSize;
  const height = raster.height / pixelSize;
  const data = new Uint8Array(width * height);
  const counts = new Float64Array(layerPriority.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      counts.fill(0);
      for (let row = 0; row < pixelSize; row++) {
        const start = (y * pixelSize + row) * raster.width + x * pixelSize;
        for (const layer of raster.data.subarray(start, start + pixelSize)) counts[layer] = counts[layer]! + 1;
      }
      let selected = river;
      for (const layer of layerPriority) {
        if (counts[layer]! > counts[selected]!) selected = layer;
      }
      data[y * width + x] = selected;
    }
  }
  return { width, height, data };
}

type GridCity = { name: string; x: number; y: number };

function cityOnDryLand({ width, height, data }: SketchRaster, { x, y }: GridCity) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return false;
  const center = data[y * width + x];
  if (center !== land && center !== mountain) return false;
  for (let row = y - 1; row <= y + 1; row++) {
    for (let col = x - 1; col <= x + 1; col++) {
      const layer = data[row * width + col];
      if (layer === sea || layer === lake) return false;
    }
  }
  return true;
}

// 두 래스터와 도시 좌표는 같은 논리 격자에 둔다.
export function inspectSketchAlignment(sketch: SketchRaster, rendered: SketchRaster, cities: readonly GridCity[]) {
  assertSketchRaster(sketch);
  assertSketchRaster(rendered);
  if (sketch.width !== rendered.width || sketch.height !== rendered.height) invalid('정렬 격자 크기');

  const counts = new Float64Array(layerPriority.length);
  const matches = new Float64Array(layerPriority.length);
  let totalMatches = 0;
  for (const [index, layer] of sketch.data.entries()) {
    counts[layer] = counts[layer]! + 1;
    if (layer === rendered.data[index]) {
      matches[layer] = matches[layer]! + 1;
      totalMatches++;
    }
  }
  const overall = totalMatches / sketch.data.length;
  const byLayer = Array.from(counts, (count, layer) => (count === 0 ? null : matches[layer]! / count));
  const unsafeCities = cities.filter((city) => !cityOnDryLand(rendered, city)).map(({ name }) => name);
  return { ok: overall >= 0.97 && unsafeCities.length === 0, overall, byLayer, unsafeCities };
}
