import { expect, it } from 'vitest';
import { readWebpSize } from './webp';

function riff(chunks: Array<[string, Buffer]>) {
  const content = Buffer.concat([
    Buffer.from('WEBP'),
    ...chunks.map(([tag, data]) => {
      const header = Buffer.alloc(8);
      header.write(tag);
      header.writeUInt32LE(data.length, 4);
      return Buffer.concat([header, data, ...(data.length & 1 ? [Buffer.alloc(1)] : [])]);
    }),
  ]);
  const header = Buffer.alloc(8);
  header.write('RIFF');
  header.writeUInt32LE(content.length, 4);
  return Buffer.concat([header, content]);
}
function lossless(width: number, height: number) {
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return data;
}
it('AC-P2-28 무손실 WebP의 기본·확장 캔버스 크기를 검사한다', () => {
  const data = lossless(2100, 1500),
    canvas = Buffer.alloc(10);
  canvas.writeUIntLE(2099, 4, 3);
  canvas.writeUIntLE(1499, 7, 3);
  expect(readWebpSize(riff([['VP8L', data]]))).toEqual({ width: 2100, height: 1500 });
  expect(
    readWebpSize(
      riff([
        ['VP8X', canvas],
        ['VP8L', data],
      ]),
    ),
  ).toEqual({ width: 2100, height: 1500 });
  canvas[0] = 2;
  expect(() =>
    readWebpSize(
      riff([
        ['VP8X', canvas],
        ['VP8L', data],
      ]),
    ),
  ).toThrow();
  canvas[0] = 0;
  canvas.writeUIntLE(999, 4, 3);
  expect(() =>
    readWebpSize(
      riff([
        ['VP8X', canvas],
        ['VP8L', data],
      ]),
    ),
  ).toThrow();
});
it('AC-P2-28 잘린 RIFF·청크·중복 이미지·손실·애니메이션을 거부한다', () => {
  const data = lossless(1000, 700),
    valid = riff([['VP8L', data]]);
  for (const invalid of [
    valid.subarray(1),
    valid.subarray(0, -1),
    riff([['VP8L', data.subarray(0, 4)]]),
    riff([
      ['VP8L', data],
      ['VP8L', data],
    ]),
    riff([['VP8 ', data]]),
    riff([['ANMF', data]]),
    riff([['VP8X', Buffer.alloc(10)]]),
  ])
    expect(() => readWebpSize(invalid)).toThrow();
  data[4] = 0xe0;
  expect(() => readWebpSize(riff([['VP8L', data]]))).toThrow();
});
