import { expect, it } from 'vitest';
import { palette } from './pixel-basemap.json';
import {
  EAST,
  NORTH,
  SOUTH,
  TERRAINS,
  WEST,
  isWaterRoute,
  roadTiles,
  shadowPaths,
  showTiles,
  terrainGrid,
  terrainPaths,
  walk,
  waterLanes,
  waterPath,
} from './terrainTiles';

const rgba = (names: (keyof typeof palette)[]) =>
  names.flatMap((name) => [...[1, 3, 5].map((at) => parseInt(palette[name].slice(at, at + 2), 16)), 255]);
const grid = (rows: (keyof typeof palette)[][]) => ({
  cells: terrainGrid(rgba(rows.flat()), rows[0]!.length, rows.length),
  columns: rows[0]!.length,
  rows: rows.length,
});

it('AC-INT-20 칸 한 변이 화면 12px 이상이면 타일로 그린다', () => {
  expect(showTiles(5.9)).toBe(false);
  expect(showTiles(6)).toBe(true);
});

it('AC-INT-20 도트 바탕 색을 지형 번호로 읽고 팔레트 밖 색은 -1이다', () => {
  expect([...terrainGrid([...rgba(['forest', 'sea']), 1, 2, 3, 255], 3, 1)]).toEqual([
    TERRAINS.indexOf('forest'),
    TERRAINS.indexOf('sea'),
    -1,
  ]);
});

it('AC-INT-20 보이는 칸만 지형별 줄 사각형으로 묶는다', () => {
  const g = grid([
    ['plains', 'plains', 'forest', 'forest'],
    ['sea', 'sea', 'sea', 'plains'],
  ]);
  const all = Object.fromEntries(
    terrainPaths(g.cells, g.columns, g.rows, { x: 0, y: 0, width: 8, height: 4 }).map((p) => [p.terrain, p.d]),
  );
  expect(all).toEqual({ sea: 'M0 2h6v2h-6z', plains: 'M0 0h4v2h-4zM6 2h2v2h-2z', forest: 'M4 0h4v2h-4z' });
  const part = terrainPaths(g.cells, g.columns, g.rows, { x: 4.5, y: 0, width: 1, height: 1 });
  expect(part.map((p) => p.terrain)).toEqual(['forest']);
});

it('AC-INT-20 길 칸은 상하좌우로만 이어지고 대각선 걸음은 가로 칸을 끼운다', () => {
  const cells = walk([
    { x: 0, y: 0 },
    { x: 4, y: 4 },
  ]);
  expect(cells).toEqual([
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 2, y: 2 },
  ]);
  for (let i = 1; i < cells.length; i += 1)
    expect(Math.abs(cells[i]!.x - cells[i - 1]!.x) + Math.abs(cells[i]!.y - cells[i - 1]!.y)).toBe(1);
});

it('AC-INT-20 땅길·다리 칸은 이웃 방향 비트를 갖고 꺼진 길·여울·물길·물길 표시 경로는 빠진다', () => {
  const sites = [
    { id: 'a', name: 'a', kind: 'CITY' as const, position: { x: 1, y: 1 } },
    { id: 'b', name: 'b', kind: 'CITY' as const, position: { x: 5, y: 1 } },
    { id: 'c', name: 'c', kind: 'CITY' as const, position: { x: 3, y: 5 } },
  ];
  const routes = [
    { id: 'ab', from: 'a', to: 'b', mode: 'LAND' as const, direction: 'BOTH' as const, enabled: true },
    { id: 'c', from: 'c', to: 'b', mode: 'FORD' as const, direction: 'BOTH' as const, enabled: true },
    { id: 'off', from: 'a', to: 'c', mode: 'LAND' as const, direction: 'BOTH' as const, enabled: false },
  ];
  const tiles = Object.fromEntries(roadTiles({ sites, routes }).map((t) => [`${t.x},${t.y}`, t.mask]));
  expect(tiles).toEqual({ '0,0': EAST, '1,0': EAST | WEST, '2,0': WEST });
  expect(roadTiles({ sites, routes }, new Set(['ab']))).toEqual([]);
  expect(NORTH | SOUTH).toBe(5);
});

it('AC-INT-20 물 위를 지나는 땅길은 물 칸을 따라 그리고 길이 없으면 직선을 쓴다', () => {
  const g = grid([
    ['plains', 'sea', 'sea', 'sea', 'sea', 'sea', 'sea', 'plains'],
    ['plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains'],
    ['plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains'],
    ['plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains'],
    ['plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains'],
  ]);
  const across = walk([
    { x: 1, y: 1 },
    { x: 15, y: 1 },
  ]);
  expect(isWaterRoute(across, g)).toBe(true);
  expect(
    isWaterRoute(
      walk([
        { x: 1, y: 9 },
        { x: 15, y: 9 },
      ]),
      g,
    ),
  ).toBe(false);
  const path = waterPath({ x: 0, y: 0 }, { x: 7, y: 0 }, g)!;
  expect(path[0]).toEqual({ x: 0, y: 0 });
  expect(path.at(-1)).toEqual({ x: 7, y: 0 });
  // 끝점 둘레 3칸 밖의 땅은 지나지 않는다.
  const land = grid([Array.from({ length: 10 }, () => 'plains' as const)]);
  expect(waterPath({ x: 0, y: 0 }, { x: 9, y: 0 }, land)).toBeNull();
  expect(waterPath({ x: 0, y: 0 }, { x: 6, y: 0 }, land)).toHaveLength(7);
  // 지도 끝 좌표는 격자 밖 칸이라 물길을 찾지 않는다(무한 역추적 방지).
  expect(waterPath({ x: 0, y: 0 }, { x: 10, y: 0 }, land)).toBeNull();
  expect(waterPath({ x: -1, y: 0 }, { x: 3, y: 0 }, land)).toBeNull();
  const sites = [
    { id: 'a', name: 'a', kind: 'CITY' as const, position: { x: 1, y: 1 } },
    { id: 'b', name: 'b', kind: 'CITY' as const, position: { x: 15, y: 1 } },
  ];
  const lanes = waterLanes(
    { sites, routes: [{ id: 'ab', from: 'a', to: 'b', mode: 'LAND', direction: 'BOTH', enabled: true }] },
    g,
  );
  expect(lanes.map((lane) => lane.id)).toEqual(['ab']);
  expect(lanes[0]!.cells).toEqual(path);
});

it('AC-INT-20 높은 산의 남쪽·동쪽 칸에 높이 차이만큼 그림자를 드리운다', () => {
  const g = grid([
    ['highMountains', 'plains'],
    ['plains', 'plains'],
  ]);
  const view = { x: 0, y: 0, width: 4, height: 4 };
  expect(shadowPaths(g, view)).toEqual([{ step: 3, d: 'M2 0h2v2h-2zM0 2h2v2h-2z' }]);
});
