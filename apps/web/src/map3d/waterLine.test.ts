import { describe, expect, it } from 'vitest';
import { shoreDistance, snapToChannel, type WaterDetail } from './waterLine';

// 가로로 흐르는 폭 3픽셀 강(y 4~6). 강 가운데는 y = 5.5(픽셀 가운데).
const river = (): WaterDetail => {
  const width = 20;
  const height = 12;
  const data = new Uint8Array(width * height);
  for (let y = 4; y <= 6; y++) for (let x = 0; x < width; x++) data[y * width + x] = 1;
  return { data, width, height };
};

describe('waterLine', () => {
  it('물 픽셀은 기슭에서 멀수록 거리가 크다', () => {
    const water = river();
    const distance = shoreDistance(water);
    expect(distance[5 * 20 + 10]).toBeGreaterThan(distance[4 * 20 + 10]!);
    expect(distance[2 * 20 + 10]).toBe(0);
  });

  it('강 옆 뭍을 지나는 수로 선은 강 가운데로 옮기고 끝 점(성)은 그대로 둔다', () => {
    const water = river();
    const distance = shoreDistance(water);
    const line = [
      { x: 1, y: 2 },
      { x: 18, y: 2 },
    ];
    const snapped = snapToChannel(line, water, distance, 1, 4);
    expect(snapped[0]).toEqual({ x: 1, y: 2 });
    expect(snapped[snapped.length - 1]).toEqual({ x: 18, y: 2 });
    const middle = snapped.slice(2, -2);
    expect(middle.length).toBeGreaterThan(0);
    for (const point of middle) expect(point.y).toBeCloseTo(5.5, 5);
  });

  it('반지름 안에 물이 없으면 점을 옮기지 않는다(그림에 없는 운하)', () => {
    const water = river();
    const distance = shoreDistance(water);
    const snapped = snapToChannel(
      [
        { x: 0, y: 11 },
        { x: 19, y: 11 },
      ],
      water,
      distance,
      1,
      2,
    );
    for (const point of snapped) expect(point.y).toBe(11);
  });
});
