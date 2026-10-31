import { expect, it } from 'vitest';
import { cellsPath, passNeighbours, rasterize, roadCells, roadLayer } from './roadPixels';

const site = (id: string, x: number, y: number) => ({
  id,
  name: id,
  kind: 'CITY' as const,
  anchorKey: Number(id.replace(/\D/g, '')) || 1,
  position: { x, y },
});
const map = {
  sites: [site('city:1', 10, 10), site('city:2', 30, 10), site('pass:3', 30, 50), site('via:4', 20, 30)],
  routes: [
    { id: 'r1', from: 'city:1', to: 'city:2', mode: 'LAND' as const, direction: 'BOTH' as const, enabled: true },
    {
      id: 'r2',
      from: 'city:2',
      to: 'pass:3',
      via: ['via:4'],
      mode: 'FORD' as const,
      direction: 'BOTH' as const,
      enabled: true,
    },
    { id: 'r3', from: 'city:1', to: 'pass:3', mode: 'LAND' as const, direction: 'BOTH' as const, enabled: false },
  ],
};

it('AC-INT-20 도로는 2단위 칸으로 끊김 없이 이어진다', () => {
  const cells = rasterize([
    { x: 0, y: 0 },
    { x: 10, y: 6 },
  ]);
  expect(cells[0]).toEqual({ x: 0, y: 0 });
  expect(cells.at(-1)).toEqual({ x: 5, y: 3 });
  for (let index = 1; index < cells.length; index += 1) {
    const step = Math.max(
      Math.abs(cells[index]!.x - cells[index - 1]!.x),
      Math.abs(cells[index]!.y - cells[index - 1]!.y),
    );
    expect(step).toBe(1);
  }
});

it('AC-INT-20 여울·물길은 두 칸씩 비우고 땅길은 다 찍는다', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 15, y: 0 },
  ];
  expect(roadCells('LAND', line)).toHaveLength(8);
  expect(roadCells('FORD', line).map((cell) => cell.x)).toEqual([0, 1, 4, 5]);
});

it('AC-INT-20 이어진 칸은 사각형 하나로 묶고 같은 자료에서 같은 path가 나온다', () => {
  expect(
    cellsPath([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 4, y: 0 },
    ]),
  ).toBe('M2 0h4v2h-4zM8 0h2v2h-2z');
  expect(roadLayer(map)).toEqual(roadLayer(structuredClone(map)));
  expect(roadLayer(map).map((layer) => layer.mode)).toEqual(['LAND', 'FORD']);
});

it('AC-INT-20 관문 이웃 점은 켜진 길의 바로 다음 점이다', () => {
  expect(passNeighbours('pass:3', map)).toEqual([{ x: 20, y: 30 }]);
  expect(passNeighbours('city:1', map)).toEqual([{ x: 30, y: 10 }]);
});
