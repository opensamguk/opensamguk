import { describe, expect, it } from 'vitest';
import { commandWorld } from '../test/commandFixture';
import {
  generalMerit,
  publicNationPower,
  rankGenerals,
  rankNations,
  type GeneralRankingBy,
  type GeneralRankingRow,
  type NationRankingBy,
  type NationRankingRow,
} from './ranking';

function general(id: number, overrides: Partial<GeneralRankingRow> = {}): GeneralRankingRow {
  return {
    id,
    name: `장수${id}`,
    nation: null,
    dedication: 0,
    experience: 0,
    wins: 0,
    captures: 0,
    ...overrides,
  };
}

describe('AC-M2-19 장수 순위', () => {
  const rows = [
    general(3, { dedication: 10, experience: 30, wins: 4, captures: 1 }),
    general(2, { dedication: 20, experience: 20, wins: 2, captures: 1 }),
    general(1, { dedication: 20, experience: 20, wins: 1, captures: 2 }),
  ];

  it.each<{ by: GeneralRankingBy; ids: number[]; values: number[] }>([
    { by: 'dedication', ids: [1, 2, 3], values: [20, 20, 10] },
    { by: 'experience', ids: [3, 1, 2], values: [30, 20, 20] },
    { by: 'merit', ids: [3, 1, 2], values: [5, 3, 3] },
  ])('$by 내림차순, 동점은 ID 순이며 순위는 중복하지 않는다', ({ by, ids, values }) => {
    const result = rankGenerals(rows, by);
    expect(result.map((row) => row.id)).toEqual(ids);
    expect(result.map((row) => row.value)).toEqual(values);
    expect(result.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(result.map((row) => row.merit)).toEqual(result.map((row) => row.wins + row.captures));
  });

  it('상위 100명 밖의 내 순위를 계산할 수 있도록 전체 순위를 남긴다', () => {
    const result = rankGenerals(
      Array.from({ length: 125 }, (_, index) => general(125 - index, { dedication: 10 })),
      'dedication',
    );
    expect(result).toHaveLength(125);
    expect(result[124]).toMatchObject({ id: 125, rank: 125, value: 10 });
  });

  it('입력 순서와 소속을 보존하고 선언되지 않은 비공개 필드를 내보내지 않는다', () => {
    const nation = { id: 1, name: '촉', color: '#123456', gold: 123456 };
    const source = [
      { ...general(2), nation, gold: 100, rice: 200, crew: 300 },
      { ...general(1), gold: 400, rice: 500, crew: 600 },
    ];
    const before = structuredClone(source);
    const result = rankGenerals(source, 'merit');
    expect(source).toEqual(before);
    expect(result[0]).not.toHaveProperty('gold');
    expect(result[0]).not.toHaveProperty('rice');
    expect(result[0]).not.toHaveProperty('crew');
    expect(result[1]!.nation).toEqual({ id: 1, name: '촉', color: '#123456' });
    expect(result[1]!.nation).not.toBe(nation);
    expect(rankGenerals([], 'merit')).toEqual([]);
    expect(generalMerit(4, 2)).toBe(6);
  });
});

describe('AC-M2-19 국가 순위', () => {
  const rows: NationRankingRow[] = [
    { id: 3, name: '오', color: '#333333', cities: 1, generals: 5, power: 100 },
    { id: 2, name: '촉', color: '#222222', cities: 2, generals: 3, power: 50 },
    { id: 1, name: '위', color: '#111111', cities: 2, generals: 3, power: 50 },
  ];

  it.each<{ by: NationRankingBy; ids: number[]; values: number[] }>([
    { by: 'cities', ids: [1, 2, 3], values: [2, 2, 1] },
    { by: 'generals', ids: [3, 1, 2], values: [5, 3, 3] },
    { by: 'power', ids: [3, 1, 2], values: [100, 50, 50] },
  ])('$by 내림차순, 동점은 ID 순이다', ({ by, ids, values }) => {
    const before = structuredClone(rows);
    const result = rankNations(rows, by);
    expect(result.map((row) => row.id)).toEqual(ids);
    expect(result.map((row) => row.value)).toEqual(values);
    expect(result.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(rows).toEqual(before);
  });

  it('정렬 결과에는 국력 계산에 쓰인 사유 자원을 내보내지 않는다', () => {
    const source = [{ ...rows[0]!, gold: 10000, rice: 20000, population: 30000, crew: 40000 }];
    expect(rankNations(source, 'power')).toEqual([{ ...rows[0]!, rank: 1, value: 100 }]);
    expect(rankNations([], 'power')).toEqual([]);
  });

  const at = { seed: 'public-power', tick: 10000, year: 191 };

  it('도시·장수 수가 같은 두 나라에서 이를 빼도 기술 등급이 남지 않는다', () => {
    const state = commandWorld();
    state.cities[4]!.nationId = null;
    state.generals[3]!.nationId = null;
    state.nations[1]!.tech = 5432;
    state.nations[2]!.tech = 6432;
    for (const id of [1, 2]) {
      expect(publicNationPower(state, id, at) - 1 - 1).not.toBe(Math.floor(state.nations[id]!.tech / 1000));
    }
  });

  it('기술과 국고가 다른 상태도 같은 공개 국력이 될 수 있다', () => {
    const first = commandWorld();
    first.nations[1]!.tech = 5000;
    const second = structuredClone(first);
    second.nations[1]!.tech += 1000;
    second.nations[1]!.gold -= 100000;
    expect(publicNationPower(first, 1, at)).toBe(publicNationPower(second, 1, at));
  });

  it('같은 시드·월·국가의 값은 재생과 다른 국가 계산 순서에 영향받지 않는다', () => {
    const state = commandWorld();
    const before = structuredClone(state);
    const first = publicNationPower(state, 1, at);
    publicNationPower(state, 2, at);
    expect(publicNationPower(structuredClone(state), 1, at)).toBe(first);
    expect(state).toEqual(before);
  });

  it('미등장 장수와 보급이 끊긴 도시의 내정은 합산하지 않는다', () => {
    const state = commandWorld();
    const first = publicNationPower(state, 1, at);
    state.generals[4]!.nationId = 1;
    state.generals[4]!.activeFromYear = at.year + 1;
    state.generals[4]!.gold = 100000000;
    state.cities[4]!.population = 1000000;
    state.cities[4]!.agriculture = 1000000;
    expect(publicNationPower(state, 1, at)).toBe(first);
  });

  it('기본 국력 126에 적용하는 월별 배율은 0.95~1.05 범위를 지킨다', () => {
    const state = commandWorld();
    Object.assign(state.nations[1]!, { gold: 10000, rice: 0, tech: 1000 });
    Object.assign(state.generals[1]!, {
      gold: 0,
      rice: 0,
      leadership: 40,
      strength: 9,
      intel: 16,
      experience: 100,
      dedication: 100,
    });
    Object.assign(state.cities[1]!, {
      population: 10000,
      populationMax: 20000,
      agriculture: 100,
      agricultureMax: 100,
      commerce: 100,
      commerceMax: 100,
      security: 100,
      securityMax: 100,
      wall: 100,
      wallMax: 100,
      defence: 100,
      defenceMax: 100,
    });
    const powers = Array.from({ length: 30 }, (_, i) => publicNationPower(state, 1, { ...at, tick: 10000 * (i + 1) }));
    expect(powers.every((power) => Number.isInteger(power) && power >= 120 && power <= 132)).toBe(true);
    expect(new Set(powers).size).toBeGreaterThan(1);
  });
});
