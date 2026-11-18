import { describe, expect, it } from 'vitest';
import { attackTargets, moveTargets, turnsForPath } from './schematicPaths';
import { countyParents, type SchematicCity } from './SchematicMap';

// 1(큰 도시, 우리) - 2(현, 우리) - 3(큰 도시, 우리) - 4(현, 적) - 5(현, 적) - 6(큰 도시, 적), 3 - 7(공백 현)
const city = (key: number, level: number, nationId: number | null, links: number[], x = key * 10): SchematicCity => ({
  key,
  name: `도시${key}`,
  level,
  x,
  y: 0,
  nationId,
  links,
  region: 1,
});
const cities = [
  city(1, 6, 1, [2]),
  city(2, 2, 1, [1, 3]),
  city(3, 6, 1, [2, 4, 7]),
  city(4, 2, 2, [3, 5]),
  city(5, 2, 2, [4, 6]),
  city(6, 7, 2, [5]),
  city(7, 2, null, [3]),
];

describe('D-103 이동과 출병 목적지', () => {
  it('이동은 우리 땅 안 어디든, 우리 땅 밖은 바로 붙은 곳만 간다', () => {
    const targets = moveTargets(cities, 1, 1);
    expect([...targets.keys()].sort()).toEqual([2, 3]);
    expect(targets.get(3)).toEqual({ path: [1, 2, 3], turns: 1, swept: [] });
    const fromFront = moveTargets(cities, 3, 1);
    expect([...fromFront.keys()].sort()).toEqual([1, 2, 4, 7]);
    expect(fromFront.get(4)?.path).toEqual([3, 4]);
  });

  it('출병은 붙은 적 거점과, 그 나라 부속 현만 지나 닿는 큰 도시를 고른다', () => {
    const targets = attackTargets(cities, 3, 1);
    expect([...targets.keys()].sort()).toEqual([4, 6, 7]);
    expect(targets.get(6)).toEqual({ path: [3, 4, 5, 6], turns: 2, swept: [4, 5] });
  });

  it('걸리는 턴은 칸 2개당 1턴이다', () => {
    expect(turnsForPath([1, 2])).toBe(1);
    expect(turnsForPath([1, 2, 3])).toBe(1);
    expect(turnsForPath([1, 2, 3, 4])).toBe(2);
  });

  it('현은 같은 군의 가장 가까운 큰 도시에 묶는다', () => {
    const parents = countyParents(cities);
    expect(parents.get(2)).toBe(1);
    expect(parents.get(4)).toBe(3);
    expect(parents.get(5)).toBe(6);
  });
});
