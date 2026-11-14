import { describe, expect, it } from 'vitest';
import { TERRAINS, type Terrain } from '../main/terrainTiles';
import { compactLabels, groundAt, heightField, isWater, siteSize, TERRAIN_HEIGHT, WATER_LEVEL } from './terrain3d';

// INT-27 0단계: 지형 종류로 만든 높이와 이름판 겹침 정리.
const index = (terrain: Terrain) => TERRAINS.indexOf(terrain);
const grid = (rows: Terrain[][]) => ({
  cells: Int8Array.from(rows.flat().map(index)),
  columns: rows[0]!.length,
  rows: rows.length,
});

describe('heightField', () => {
  it('산은 평야보다 높고 물은 물높이 아래, 땅은 물높이 위에 남는다', () => {
    const g = grid([
      ['sea', 'plains', 'mountains'],
      ['sea', 'plains', 'mountains'],
      ['sea', 'plains', 'highMountains'],
    ]);
    const field = heightField(g);
    expect(field[2]!).toBeGreaterThan(field[1]!);
    expect(field[0]!).toBeLessThan(WATER_LEVEL);
    expect(field[1]!).toBeGreaterThan(WATER_LEVEL);
    expect(isWater(index('sea'))).toBe(true);
    expect(isWater(index('plains'))).toBe(false);
  });

  it('평균을 내지 않으면 지형 표의 높이 그대로다', () => {
    const field = heightField(grid([['hills']]), 0);
    expect(field[0]).toBe(TERRAIN_HEIGHT.hills);
  });
});

describe('groundAt', () => {
  it('지도 좌표를 칸으로 바꿔 높이를 읽고 물 위로는 물높이를 돌려준다', () => {
    const g = grid([
      ['plains', 'mountains'],
      ['sea', 'sea'],
    ]);
    const field = heightField(g, 0);
    const canvas = { width: 20, height: 20 };
    expect(groundAt(field, g, canvas, 15, 2)).toBeCloseTo(TERRAIN_HEIGHT.mountains);
    expect(groundAt(field, g, canvas, 5, 18)).toBe(WATER_LEVEL);
  });
});

describe('siteSize', () => {
  it('큰 도시일수록 넓고 높다', () => {
    expect(siteSize('CITY', 8).side).toBeGreaterThan(siteSize('CITY', 1).side);
    expect(siteSize('CITY', 8).height).toBeGreaterThan(siteSize('CITY', 1).height);
    expect(siteSize('PASS', undefined).height).toBeGreaterThan(siteSize('PORT', undefined).height);
  });
});

describe('compactLabels', () => {
  it('겹치면 중요도가 낮은 이름판을 줄이고 떨어진 것은 둔다', () => {
    const compact = compactLabels([
      { id: 'small', x: 100, y: 100, width: 40, height: 24, priority: 10 },
      { id: 'capital', x: 110, y: 104, width: 40, height: 24, priority: 80 },
      { id: 'far', x: 400, y: 300, width: 40, height: 24, priority: 5 },
    ]);
    expect([...compact]).toEqual(['small']);
  });
});
