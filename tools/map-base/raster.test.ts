import { crc32, deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { inspectSketchAlignment, readSketchPng, reduceSketchRaster, sketchRasterHash } from './raster';
import { encodeSketchPng } from '../../apps/web/src/mapEditor/sketch';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const palette = Buffer.from('2b5d8ccbb98a4f8fd07a63476aa6d8', 'hex');
const header = Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 3, 0, 0, 0]);
const rows = Buffer.from([0, 0, 1, 2, 0, 3, 4, 1]);
const pixels = new Uint8Array([0, 1, 2, 3, 4, 1]);
const expected = { width: 3, height: 2 };
const fixedHash = '2b05018ceff683238a665ebccbb2dfd7236f35d9ded46652fd4a6dbc13c7a914';

function chunk(type: string, body = Buffer.alloc(0)) {
  const output = Buffer.alloc(body.length + 12);
  output.writeUInt32BE(body.length);
  output.write(type, 4, 4, 'latin1');
  body.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, output.length - 4)), output.length - 4);
  return output;
}

const png = (chunks: Buffer[]) => Buffer.concat([signature, ...chunks]);
const ihdr = () => chunk('IHDR', header);
const plte = () => chunk('PLTE', palette);
const idat = (data = rows) => chunk('IDAT', deflateSync(data));
const iend = () => chunk('IEND');
const valid = () => png([ihdr(), plte(), idat(), iend()]);

it('AC-P2-28 격자 안의 최다 지형을 쓰고 동점은 강·호수·산·땅·바다 순으로 고른다', () => {
  const rows = [
    [0, 1, 3, 4, 4, 2, 0, 0, 1, 3],
    [1, 0, 4, 3, 2, 4, 2, 0, 3, 1],
  ];
  const raster = { width: 10, height: 2, data: Uint8Array.from(rows.flat()) };
  expect(reduceSketchRaster(raster, 2)).toEqual({ width: 5, height: 1, data: Uint8Array.of(1, 4, 2, 0, 3) });
  expect(reduceSketchRaster(raster, 1)).toEqual(raster);
  expect(raster.data).toEqual(Uint8Array.from(rows.flat()));
  for (const size of [0, 1.5, 3]) expect(() => reduceSketchRaster(raster, size)).toThrow('격자 크기');
  expect(() => reduceSketchRaster({ ...raster, data: raster.data.map(() => 5) }, 2)).toThrow('화소');
});

it('AC-P2-28 전체·지형별 일치율을 보고하고 97% 이상이면 통과한다', () => {
  const data = new Uint8Array(100).fill(1);
  data.set([0, 0, 0, 0, 4]);
  const sketch = { width: 10, height: 10, data };
  const rendered = { ...sketch, data: data.slice() };
  expect(inspectSketchAlignment(sketch, rendered, [])).toEqual({
    ok: true,
    overall: 1,
    byLayer: [1, 1, null, null, 1],
    unsafeCities: [],
  });
  rendered.data.fill(1, 0, 3);
  expect(inspectSketchAlignment(sketch, rendered, [])).toEqual({
    ok: true,
    overall: 0.97,
    byLayer: [0.25, 1, null, null, 1],
    unsafeCities: [],
  });
  rendered.data[3] = 1;
  expect(inspectSketchAlignment(sketch, rendered, [])).toMatchObject({ ok: false, overall: 0.96 });
  expect(() => inspectSketchAlignment(sketch, { ...rendered, width: 20, height: 5 }, [])).toThrow('정렬 격자 크기');
});

it('AC-P2-28 도시는 땅·산에 있어야 하며 둘레의 강은 허용하고 바다·호수는 거부한다', () => {
  const data = new Uint8Array(100).fill(1);
  data.set([3, 2], 11);
  data.set([2, 1, 4], 15);
  const raster = { width: 10, height: 10, data };
  const cities = [
    { name: '산성', x: 1, y: 1 },
    { name: '강', x: 5, y: 1 },
    { name: '호수 옆', x: 6, y: 1 },
    { name: '경계', x: 9, y: 1 },
  ];
  expect(inspectSketchAlignment(raster, raster, cities)).toMatchObject({
    ok: false,
    overall: 1,
    unsafeCities: ['강', '호수 옆', '경계'],
  });
  const rendered = { ...raster, data: data.slice() };
  rendered.data[11] = 0;
  expect(inspectSketchAlignment(raster, rendered, cities.slice(0, 1))).toMatchObject({
    ok: false,
    overall: 0.99,
    unsafeCities: ['산성'],
  });
});

it('AC-P2-28 기존 편집기의 실제 PNG 부호화 결과를 읽는다', async () => {
  const encoded = await encodeSketchPng({ ...expected, data: pixels });
  expect(readSketchPng(encoded, expected)).toEqual({ ...expected, data: pixels });
  expect(sketchRasterHash(readSketchPng(encoded, expected))).toBe(fixedHash);
});

it('AC-P2-28 분할 IDAT와 오프셋이 있는 입력을 읽고 원본을 보존한다', () => {
  const compressed = deflateSync(rows);
  const encoded = png([
    ihdr(),
    plte(),
    chunk('IDAT', compressed.subarray(0, 3)),
    chunk('IDAT', compressed.subarray(3)),
    iend(),
  ]);
  const padded = Buffer.concat([Buffer.from([42]), encoded, Buffer.from([43])]);
  const before = Buffer.from(padded);
  const raster = readSketchPng(padded.subarray(1, -1), expected);
  expect(raster).toEqual({ ...expected, data: pixels });
  expect(sketchRasterHash(raster)).toBe(fixedHash);
  expect(padded).toEqual(before);
});

it('AC-P2-28 래스터 해시는 압축 바이트와 무관하며 크기·팔레트 순서·화소를 고정한다', () => {
  const encoded = [0, 9].map((level) => png([ihdr(), plte(), chunk('IDAT', deflateSync(rows, { level })), iend()]));
  expect(encoded[0]).not.toEqual(encoded[1]);
  expect(encoded.map((bytes) => sketchRasterHash(readSketchPng(bytes, expected)))).toEqual([fixedHash, fixedHash]);
  expect(sketchRasterHash({ width: 2, height: 3, data: pixels })).not.toBe(fixedHash);
  expect(sketchRasterHash({ ...expected, data: new Uint8Array([0, 1, 2, 3, 4, 0]) })).not.toBe(fixedHash);
});

it.each([
  ['IHDR 누락', () => png([plte(), idat(), iend()])],
  ['IHDR 중복', () => png([ihdr(), ihdr(), plte(), idat(), iend()])],
  ['IHDR 길이', () => png([chunk('IHDR', header.subarray(0, 12)), plte(), idat(), iend()])],
  ['팔레트 누락', () => png([ihdr(), idat(), iend()])],
  ['팔레트 순서', () => png([ihdr(), idat(), plte(), iend()])],
  ['팔레트 값', () => png([ihdr(), chunk('PLTE', Buffer.alloc(15)), idat(), iend()])],
  ['팔레트 개수', () => png([ihdr(), chunk('PLTE', palette.subarray(0, 12)), idat(), iend()])],
  ['IDAT 누락', () => png([ihdr(), plte(), iend()])],
  ['IEND 누락', () => png([ihdr(), plte(), idat()])],
  ['IEND 본문', () => png([ihdr(), plte(), idat(), chunk('IEND', Buffer.from([0]))])],
  ['IEND 뒤 데이터', () => Buffer.concat([valid(), Buffer.from([0])])],
  ['추가 청크', () => png([ihdr(), plte(), chunk('tEXt', Buffer.from('note')), idat(), iend()])],
  ['높은 비트 청크 이름', () => png([chunk('\u00c9HDR', header), plte(), idat(), iend()])],
  ['잘린 청크', () => valid().subarray(0, -1)],
  ['짧은 화소', () => png([ihdr(), plte(), idat(rows.subarray(0, -1)), iend()])],
  ['긴 화소', () => png([ihdr(), plte(), idat(Buffer.concat([rows, Buffer.from([0])])), iend()])],
  ['깨진 압축', () => png([ihdr(), plte(), chunk('IDAT', Buffer.from([1, 2, 3])), iend()])],
] as const)('AC-P2-28 %s를 거부한다', (_label, makePng) => {
  expect(() => readSketchPng(makePng(), expected)).toThrow('밑그림');
});

it.each([8, 9, 10, 11, 12])('AC-P2-28 IHDR 부호화 바이트 %i의 변경을 거부한다', (index) => {
  const changed = Buffer.from(header);
  changed[index] = changed[index]! + 1;
  expect(() => readSketchPng(png([chunk('IHDR', changed), plte(), idat(), iend()]), expected)).toThrow('IHDR');
});

it('AC-P2-28 서명·CRC·청크 길이·기대 크기를 검사한다', () => {
  const badSignature = valid();
  badSignature[0] = 0;
  expect(() => readSketchPng(badSignature, expected)).toThrow('서명');
  const badCrc = valid();
  badCrc[29] = badCrc[29]! ^ 1;
  expect(() => readSketchPng(badCrc, expected)).toThrow('CRC');
  const badLength = valid();
  badLength.writeUInt32BE(0xffff_ffff, 8);
  expect(() => readSketchPng(badLength, expected)).toThrow('길이');
  expect(() => readSketchPng(valid(), { width: 4, height: 2 })).toThrow('크기');
  expect(() => readSketchPng(valid(), { width: 0, height: 2 })).toThrow('크기');
  expect(() => readSketchPng(valid(), { width: Number.MAX_SAFE_INTEGER, height: 2 })).toThrow('크기');
});

it('AC-P2-28 행 필터와 팔레트 번호는 압축을 푼 뒤에도 검사한다', () => {
  for (const [index, value] of [
    [0, 1],
    [4, 2],
    [1, 5],
    [7, 255],
  ] as const) {
    const changed = Buffer.from(rows);
    changed[index] = value;
    expect(() => readSketchPng(png([ihdr(), plte(), idat(changed), iend()]), expected)).toThrow('밑그림');
  }
  expect(() => sketchRasterHash({ ...expected, data: new Uint8Array([0]) })).toThrow('화소');
  expect(() => sketchRasterHash({ ...expected, data: new Uint8Array([0, 1, 2, 3, 4, 5]) })).toThrow('화소');
});
