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

export function sketchRasterHash({ width, height, data }: SketchRaster): string {
  dimensions(width, height);
  if (data.length !== width * height || data.some((value) => value > 4)) invalid('화소');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  return createHash('sha256').update(header).update(palette).update(data).digest('hex');
}
