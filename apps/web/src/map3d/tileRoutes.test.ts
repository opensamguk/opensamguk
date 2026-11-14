import { describe, expect, it } from 'vitest';
import { FLAG_BRIDGE, FLAG_MAJOR, planTileRoutes, tileCost, type TileTerrain } from './tileRoutes';

// INT-27 칸 길: 8방향 칸 경로, 육로·수로·해로의 칸 비용, 큰길 모임과 다리 표시.
function grid(rows: string[]) {
  const map: Record<string, TileTerrain> = { '.': 'plain', '^': 'mountain', '~': 'river', '=': 'sea', '#': 'void' };
  const cells = rows
    .join('')
    .split('')
    .map((c) => map[c]!);
  return { columns: rows[0]!.length, rows: rows.length, at: (i: number) => cells[i]! };
}

describe('tileCost', () => {
  it('육로는 바다를 못 지나고 수로·해로는 땅을 못 지난다', () => {
    expect(tileCost('LAND', 'sea')).toBe(Infinity);
    expect(tileCost('SEA', 'plain')).toBe(Infinity);
    expect(tileCost('RIVER', 'river')).toBeLessThan(tileCost('RIVER', 'sea'));
    expect(tileCost('BRIDGE', 'river')).toBeLessThan(tileCost('LAND', 'river'));
  });
});

describe('planTileRoutes', () => {
  it('산을 돌아가는 육로를 찾고 양 끝 칸에 서로 마주 보는 방향 비트를 둔다', () => {
    const g = grid(['.....', '.^^^.', '.....']);
    const plan = planTileRoutes(g.columns, g.rows, g.at, [{ id: 'a', mode: 'LAND', from: 5, to: 9 }]);
    const path = plan.paths.get('a')!;
    expect(path[0]).toBe(5);
    expect(path[path.length - 1]).toBe(9);
    expect(path.some((i) => g.at(i) === 'mountain')).toBe(false);
    expect(plan.land[5]).not.toBe(0);
  });

  it('강 칸을 건너는 육로는 다리 표시, 길 셋이 지나는 칸은 큰길', () => {
    const g = grid(['..~..']);
    const routes = ['a', 'b', 'c'].map((id) => ({ id, mode: 'BRIDGE' as const, from: 0, to: 4 }));
    const plan = planTileRoutes(g.columns, g.rows, g.at, routes);
    expect(plan.flags[2]! & FLAG_BRIDGE).toBeTruthy();
    expect(plan.flags[2]! & FLAG_MAJOR).toBeTruthy();
  });

  it('해로는 바다 칸만 지나고 출발·도착은 바닷가 땅 칸이어도 된다', () => {
    const g = grid(['.===.', '.....']);
    const plan = planTileRoutes(g.columns, g.rows, g.at, [{ id: 's', mode: 'SEA', from: 0, to: 4 }]);
    const path = plan.paths.get('s')!;
    expect(path.slice(1, -1).every((i) => g.at(i) === 'sea')).toBe(true);
    expect(plan.water[2]).not.toBe(0);
    expect(plan.land[2]).toBe(0);
  });

  it('닿을 수 없으면 경로가 없다', () => {
    const g = grid(['.#.']);
    const plan = planTileRoutes(g.columns, g.rows, g.at, [{ id: 'x', mode: 'LAND', from: 0, to: 2 }]);
    expect(plan.paths.has('x')).toBe(false);
  });
});
