import { describe, expect, it } from 'vitest';
import { buildRoadNetwork, choosePassOrient, cityGates, passGates, type RoadSite } from './roadNetwork';

// INT-27 길 그물: 겹친 길은 한 토막, 끝은 성문, 관문은 길 방향 그림.
describe('buildRoadNetwork', () => {
  // 칸 번호 = y * 10 + x, 칸 가운데 = (x * 10, y * 10).
  const centre = (tile: number) => ({ x: (tile % 10) * 10, y: Math.floor(tile / 10) * 10 });
  const city = (id: string, tile: number): [number, RoadSite] => [
    tile,
    { id, kind: 'CITY', centre: centre(tile), width: 8 },
  ];

  it('같은 칸을 지나는 두 길은 갈림점에서 나뉘고 겹친 줄기는 한 번만 그린다', () => {
    const sites = new Map([city('a', 0), city('b', 5), city('c', 55)]);
    // a → b(0..5), a → c(0..3 같은 줄기, 3에서 꺾여 내려감)
    const { segments } = buildRoadNetwork(
      [
        { tiles: [0, 1, 2, 3, 4, 5], major: true },
        { tiles: [0, 1, 2, 3, 13, 23, 33, 43, 53, 54, 55], major: false },
      ],
      centre,
      (tile) => sites.get(tile),
      0,
    );
    // 토막: a–3(겹친 줄기, 대로), 3–b, 3–c.
    expect(segments).toHaveLength(3);
    expect(segments.filter((segment) => segment.major)).toHaveLength(2);
  });

  it('길 끝은 성 가운데가 아니라 들어오는 방향의 성문에 붙는다', () => {
    const sites = new Map([city('a', 0), city('b', 3)]);
    const { segments } = buildRoadNetwork(
      [{ tiles: [0, 1, 2, 3], major: false }],
      centre,
      (tile) => sites.get(tile),
      0,
    );
    const start = segments[0]!.points[0]!;
    const gates = cityGates(8).map((gate) => ({ x: gate.x, y: gate.y }));
    expect(gates.some((gate) => Math.abs(gate.x - start.x) < 1e-6 && Math.abs(gate.y - start.y) < 1e-6)).toBe(true);
    expect(start.x).toBeGreaterThan(0);
  });

  it('위아래로 지나는 관문은 가로 성벽(h), 왼쪽 아래↔오른쪽 위는 기본(a) 그림이다', () => {
    expect(
      choosePassOrient(
        [
          { x: 0, y: -1 },
          { x: 0, y: 1 },
        ],
        ['a', 'b', 'h', 'v'],
      ),
    ).toBe('h');
    expect(
      choosePassOrient(
        [
          { x: 2, y: -1 },
          { x: -2, y: 1 },
        ],
        ['a', 'b', 'h', 'v'],
      ),
    ).toBe('a');
    expect(
      choosePassOrient(
        [
          { x: 2, y: 1 },
          { x: -2, y: -1 },
        ],
        ['a', 'b'],
      ),
    ).toBe('b');
    expect(passGates('v', 8)).toEqual([
      { x: -4, y: 0 },
      { x: 4, y: 0 },
    ]);
  });
});
