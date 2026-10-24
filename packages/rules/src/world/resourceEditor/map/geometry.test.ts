import { describe, expect, it } from 'vitest';
import { isClosedRing, pointInRings } from './geometry';
import type { Ring } from './format';

const square: Ring = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
  [0, 0],
];
describe('짝홀 기하', () => {
  it('닫힘과 최소 점 수를 확인한다', () => {
    expect(isClosedRing(square)).toBe(true);
    expect(isClosedRing(square.slice(0, -1))).toBe(false);
    expect(
      isClosedRing([
        [0, 0],
        [0, 0],
        [0, 0],
      ]),
    ).toBe(false);
  });
  it('안·밖·변·꼭짓점과 겹친 고리를 판정한다', () => {
    expect(pointInRings([50, 50], [square])).toBe(true);
    expect(pointInRings([150, 50], [square])).toBe(false);
    expect(pointInRings([0, 50], [square])).toBe(true);
    expect(pointInRings([0, 0], [square])).toBe(true);
    expect(pointInRings([50, 50], [square, square])).toBe(false);
    expect(pointInRings([50, 50], [square.slice(0, -1)])).toBe(false);
  });
  it('자기 교차도 짝홀 규칙으로 판정한다', () => {
    const crossed: Ring = [
      [0, 0],
      [100, 100],
      [0, 100],
      [100, 0],
      [0, 0],
    ];
    expect(pointInRings([50, 10], [crossed])).toBe(true);
    expect(pointInRings([10, 50], [crossed])).toBe(false);
  });
});
