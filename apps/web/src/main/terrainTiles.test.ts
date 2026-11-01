import { expect, it } from 'vitest';
import { palette } from './pixel-basemap.json';
import {
  EAST,
  NORTH,
  SOUTH,
  TERRAINS,
  WEST,
  clearRun,
  gatedWalk,
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

it('D-052 남문만 있는 표식에서 북쪽 상대로 갈 때 남문으로 나가 옆으로 비켜 돌고 표식을 가로지르지 않는다', () => {
  // 거점 중심 칸 (50,50), 표식 반지름 2칸, 남문만. 상대는 북쪽 (50,20).
  const path = gatedWalk(
    [
      { x: 101, y: 101 },
      { x: 101, y: 41 },
    ],
    [{ cells: 2, allowed: ['S'] }, 0],
  );
  expect(path.slice(1, 4)).toEqual([
    { x: 50, y: 51 },
    { x: 50, y: 52 },
    { x: 50, y: 53 },
  ]);
  const inside = (point: { x: number; y: number }) => Math.abs(point.x - 50) <= 2 && Math.abs(point.y - 50) <= 2;
  expect(path.slice(4).some(inside)).toBe(false);
  expect(path.at(-1)).toEqual({ x: 50, y: 20 });
});

it('D-052 남북 관은 길 방향 문으로만 드나든다', () => {
  const path = gatedWalk(
    [
      { x: 101, y: 101 },
      { x: 141, y: 161 },
    ],
    [{ cells: 1, allowed: ['N', 'S'] }, 0],
  );
  expect(path[1]).toEqual({ x: 50, y: 51 });
});

it('D-052 남문만 있는 두 표식이 위아래로 붙어 있어도 가운데 길이 어느 표식 상자도 지나지 않는다', () => {
  // 애뢰(아래)·영창(위)처럼 같은 열, 반지름 1칸, 남문만.
  const north = { x: 134, y: 749 };
  const south = { x: 134, y: 762 };
  const path = gatedWalk(
    [north, south],
    [
      { cells: 1, allowed: ['S'] },
      { cells: 1, allowed: ['S'] },
    ],
  );
  const box = (center: { x: number; y: number }) => ({ x: Math.floor(center.x / 2), y: Math.floor(center.y / 2) });
  const inside = (point: { x: number; y: number }, center: { x: number; y: number }) =>
    Math.abs(point.x - center.x) <= 1 && Math.abs(point.y - center.y) <= 1;
  const [a, b] = [box(north), box(south)];
  // 처음 문 길(중심→문 밖)과 마지막 문 길을 뺀 구간은 두 상자 밖이다.
  const middle = path.slice(3, -3);
  expect(middle.some((point) => inside(point, a) || inside(point, b))).toBe(false);
});

it('D-052 강릉(네 문)·공안(남문)처럼 붙은 표식은 상대 상자로 들어가지 않는 문을 골라 상자를 밟지 않고 잇는다', () => {
  const big = { x: 472, y: 612 }; // 칸 (236,306), 반지름 3칸, 네 문
  const small = { x: 472, y: 622 }; // 칸 (236,311), 반지름 1칸, 남문만
  const path = gatedWalk(
    [big, small],
    [
      { cells: 3, allowed: ['N', 'E', 'S', 'W'] },
      { cells: 1, allowed: ['S'] },
    ],
  );
  const inside = (point: { x: number; y: number }, x: number, y: number, r: number) =>
    Math.abs(point.x - x) <= r && Math.abs(point.y - y) <= r;
  // 첫 문 길(강릉 중심→문)과 마지막 문 길(공안 남문→중심)을 빼면 두 상자 밖이다.
  const firstOut = path.findIndex((point) => !inside(point, 236, 306, 3));
  const lastOut = path.length - 1 - [...path].reverse().findIndex((point) => !inside(point, 236, 311, 1));
  const middle = path.slice(firstOut, lastOut + 1);
  expect(middle.some((point) => inside(point, 236, 306, 3) || inside(point, 236, 311, 1))).toBe(false);
  expect(path.at(-1)).toEqual({ x: 236, y: 311 });
  // 공안에는 남문으로 들어온다.
  expect(path.at(-2)).toEqual({ x: 236, y: 312 });
});

it('D-052 상자를 같은 칸 수만큼 밟아야 하면 그중 가장 짧은 길을 고른다', () => {
  // 시작 문 밖 칸이 상대 상자에 붙어 꺾임 길이 모두 막힐 때도, 우회는 상자를 덜 밟고 가장 짧아야 한다.
  const path = gatedWalk(
    [
      { x: 101, y: 101 },
      { x: 101, y: 121 },
    ],
    [
      { cells: 2, allowed: ['S'] },
      { cells: 2, allowed: ['N'], half: { x: 6, y: 2 } },
    ],
  );
  // 문 밖으로 곧게 나가 바로 상대 북문으로 들어가는 길이 가장 짧다(가로로 돌지 않는다).
  expect(path.every((point) => point.x === 50)).toBe(true);
});

it('D-052 피할 수 없는 상자는 가장 적게 밟고, 같은 칸 수면 가장 짧은 길을 고른다', () => {
  // x=5 세로 벽이 찾는 범위 전체를 막아 한 칸은 밟아야 한다. 막힌 기본 꺾임은 쓰지 않는다.
  const wall = (point: { x: number; y: number }) => point.x === 5;
  const start = { x: 0, y: 0 };
  const end = { x: 10, y: 0 };
  const path = clearRun(start, end, wall, [[start, end]]);
  expect(path.filter(wall)).toHaveLength(1);
  expect(path).toHaveLength(10);
  expect(path.at(-1)).toEqual(end);
});
