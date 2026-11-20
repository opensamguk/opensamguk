import { describe, expect, it } from 'vitest';
import type { PublicGeography } from '@opensamguk/shared';
import { along, cellsToPoints, pathPoints, riverLines, routePath, simplify } from './routes3d';

// INT-27: 3D 지도의 길·강·행군 경로 계산.
type Route = PublicGeography['routes'][number];
const route = (id: string, from: string, to: string, direction: 'BOTH' | 'FORWARD' = 'BOTH'): Route =>
  ({ id, from, to, mode: 'LAND', direction, enabled: true }) as Route;

describe('routePath', () => {
  const routes = [
    route('ab', 'a', 'b'),
    route('bc', 'b', 'c'),
    route('cd', 'c', 'd', 'FORWARD'),
    route('ad', 'a', 'd'),
  ];

  it('길 수가 가장 적은 경로를 고르고 거꾸로 가는 길을 표시한다', () => {
    expect(routePath(routes, 'a', 'd')?.map((step) => step.route.id)).toEqual(['ad']);
    expect(routePath(routes, 'c', 'a')).toEqual([
      { route: routes[1], reverse: true },
      { route: routes[0], reverse: true },
    ]);
  });

  it('한 방향 길은 거꾸로 가지 않고, 닿지 못하면 null이다', () => {
    const oneWay = [route('cd', 'c', 'd', 'FORWARD')];
    expect(routePath(oneWay, 'c', 'd')).toHaveLength(1);
    expect(routePath(oneWay, 'd', 'c')).toBeNull();
    expect(routePath(oneWay, 'c', 'c')).toEqual([]);
  });
});

describe('pathPoints', () => {
  it('길 점을 방향에 맞춰 잇고 겹치는 이음점은 한 번만 둔다', () => {
    const routes = [route('ab', 'a', 'b'), route('cb', 'c', 'b')];
    const lines = new Map([
      [
        'ab',
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ],
      ],
      [
        'cb',
        [
          { x: 5, y: 5 },
          { x: 5, y: 0 },
        ],
      ],
    ]);
    const points = pathPoints(
      [
        { route: routes[0]!, reverse: false },
        { route: routes[1]!, reverse: true },
      ],
      lines,
      () => undefined,
    );
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
    ]);
  });
});

describe('along·simplify·cellsToPoints·riverLines', () => {
  it('거리 비율로 위치와 방향을 구한다', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(along(line, 0.25)).toMatchObject({ x: 5, y: 0, angle: 0 });
    expect(along(line, 0.75)).toMatchObject({ x: 10, y: 5 });
    expect(along(line, 0.75).angle).toBeCloseTo(Math.PI / 2);
  });

  it('곧은 칸 길은 꺾이는 곳만 남기고 칸 가운데를 지난다', () => {
    const points = cellsToPoints([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
    ]);
    expect(simplify(points)).toEqual([points[0], points[2], points[3]]);
    expect(points[0]!.x).toBeGreaterThan(0);
  });

  it('이어진 강 조각은 한 선으로 묶는다', () => {
    const lines = riverLines('M1,1L2,2M2,2L3,3M10,10L11,11');
    expect(lines).toEqual([
      [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ],
      [
        { x: 10, y: 10 },
        { x: 11, y: 11 },
      ],
    ]);
  });
});
