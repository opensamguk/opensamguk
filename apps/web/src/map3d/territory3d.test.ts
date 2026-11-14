import { describe, expect, it } from 'vitest';
import { fromTile, reachOf, territoryTiles, toTile } from './territory3d';

// INT-27·INT-28 초안: 45° 돌린 영지 칸과 성마다 다른 영지 크기.
const canvas = { width: 200, height: 140 };

describe('toTile·fromTile', () => {
  it('서로 되돌린다', () => {
    const { u, v } = toTile(37, 91, canvas, 8);
    const back = fromTile(u, v, canvas, 8);
    expect(back.x).toBeCloseTo(37);
    expect(back.y).toBeCloseTo(91);
  });
});

describe('territoryTiles', () => {
  const land = () => true;
  const count = (owner: Int32Array, key: number) => owner.filter((value) => value === key).length;

  it('큰 성이 작은 성보다 넓은 영지를 갖는다', () => {
    const tiles = territoryTiles(
      [
        { key: 1, x: 60, y: 70, level: 8, color: '#ff0000' },
        { key: 2, x: 140, y: 70, level: 1, color: '#0000ff' },
      ],
      canvas,
      8,
      land,
    );
    expect(count(tiles.owner, 1)).toBeGreaterThan(count(tiles.owner, 2));
    expect(reachOf(8)).toBeGreaterThan(reachOf(1));
    // 이(4, 이민족 본거)는 종류 코드라 소(5)보다 넓다. 진(2)은 소보다 좁다.
    expect(reachOf(4)).toBeGreaterThan(reachOf(5));
    expect(reachOf(2)).toBeLessThan(reachOf(5));
  });

  it('무대 안 땅은 빈 칸 없이 채우고 무대 밖 판 가장자리만 오지로 둔다', () => {
    const wide = { width: 800, height: 140 };
    const tiles = territoryTiles(
      [
        { key: 1, x: 100, y: 70, level: 1, color: '#ff0000' },
        { key: 2, x: 220, y: 70, level: 1, color: '#00ff00' },
      ],
      wide,
      8,
      land,
    );
    const at = (x: number, y: number) => {
      const { u, v } = toTile(x, y, wide, 8);
      return tiles.owner[(Math.floor(v) - tiles.originY) * tiles.columns + (Math.floor(u) - tiles.originX)];
    };
    // 두 성 사이 한가운데(닿는 거리 밖)도 어느 한쪽 영지다.
    expect([1, 2]).toContain(at(160, 70));
    // 성에서 STAGE칸 넘게 먼 오른쪽 끝은 오지다.
    expect(at(780, 70)).toBe(-1);
  });

  it('바다 건너 땅은 직선으로 더 가까워도 땅으로 이어진 성의 영지다', () => {
    const wide = { width: 400, height: 200 };
    // 가운데 세로 바다(x 180~220)가 왼쪽 땅과 오른쪽 땅을 가른다. 오른쪽 땅은 아래쪽 띠(y > 170)로만 이어진다.
    const sea = (x: number, y: number) => !(x > 180 && x < 220 && y < 170);
    const tiles = territoryTiles(
      [
        { key: 1, x: 170, y: 40, level: 4, color: '#ff0000' },
        { key: 2, x: 300, y: 60, level: 1, color: '#0000ff' },
      ],
      wide,
      8,
      sea,
    );
    const at = (x: number, y: number) => {
      const { u, v } = toTile(x, y, wide, 8);
      return tiles.owner[(Math.floor(v) - tiles.originY) * tiles.columns + (Math.floor(u) - tiles.originX)];
    };
    // 바다 바로 건너(직선으로는 성 1이 가깝다)도 땅길로는 성 2가 가깝다.
    expect(at(235, 40)).toBe(2);
  });

  it('호수 칸은 둘레 성의 영지다', () => {
    const lake = (x: number, y: number) => Math.hypot(x - 130, y - 70) < 20;
    const tiles = territoryTiles(
      [{ key: 3, x: 100, y: 70, level: 3, color: '#00ff00' }],
      canvas,
      8,
      (x, y) => !lake(x, y),
      lake,
    );
    const { u, v } = toTile(130, 70, canvas, 8);
    expect(tiles.owner[(Math.floor(v) - tiles.originY) * tiles.columns + (Math.floor(u) - tiles.originX)]).toBe(3);
  });

  it('물 칸은 주인이 없고, 나라 없는 성은 색이 0이다', () => {
    const tiles = territoryTiles([{ key: 7, x: 80, y: 70, level: 3, color: null }], canvas, 8, (x) => x < 100);
    const owned = [...tiles.owner.keys()].filter((index) => tiles.owner[index] === 7);
    expect(owned.length).toBeGreaterThan(0);
    for (const index of owned) {
      expect([...tiles.data.slice(index * 4, index * 4 + 3)]).toEqual([0, 0, 0]);
      expect(tiles.data[index * 4 + 3]).toBe(1);
    }
    // 오른쪽(물)에는 주인 칸이 없다.
    const centreOf = (index: number) =>
      fromTile(
        tiles.originX + (index % tiles.columns) + 0.5,
        tiles.originY + Math.floor(index / tiles.columns) + 0.5,
        canvas,
        8,
      );
    expect(owned.every((index) => centreOf(index).x < 100)).toBe(true);
  });
});
