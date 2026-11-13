import { describe, expect, it } from 'vitest';
import { cityDistances, displayName, groupByDistance } from './targets';

describe('INT-25 인자 입력 대상 계산', () => {
  const cities = [
    { key: 1, name: '허창', level: 8, nationId: 1, links: [2, 3] },
    { key: 2, name: '진류', level: 6, nationId: 2, links: [1, 4] },
    { key: 3, name: '진', level: 6, nationId: 1, links: [1] },
    { key: 4, name: '복양', level: 6, nationId: 3, links: [2] },
    { key: 5, name: '고립', level: 1, nationId: null, links: [] },
  ];

  it('연결선을 따라 칸 수를 센다', () => {
    const d = cityDistances(cities, 1);
    expect(Object.fromEntries(d)).toEqual({ 1: 0, 2: 1, 3: 1, 4: 2 });
    expect(cityDistances(cities, null).size).toBe(0);
  });

  it('거리별로 묶고 같은 거리에서는 다른 국가 도시를 먼저 둔다', () => {
    const groups = groupByDistance(
      cities.filter((city) => city.key !== 1),
      cityDistances(cities, 1),
      1,
    );
    expect(groups.map((g) => [g.distance, g.items.map((c) => c.name)])).toEqual([
      [1, ['진류', '진']],
      [2, ['복양']],
      [null, ['고립']],
    ]);
  });

  it('장수 이름의 괄호와 그 안을 뺀다', () => {
    expect(displayName('조조(曹操)')).toBe('조조');
    expect(displayName('유도(145년생)')).toBe('유도');
    expect(displayName('관우')).toBe('관우');
    expect(displayName('(무명)')).toBe('(무명)');
  });
});
