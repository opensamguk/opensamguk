import { describe, expect, it } from 'vitest';
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

  it('공개 국력은 도시·장수·기술 1000단위 구간의 합이며 사유 자원을 받지 않는다', () => {
    expect(publicNationPower(3, 12, 999.99)).toBe(15);
    expect(publicNationPower(3, 12, 1_000)).toBe(16);
    expect(publicNationPower(3, 12, 1_999.99)).toBe(16);
    expect(publicNationPower(3, 12, 2_000)).toBe(17);
    expect(publicNationPower(3, 12, 11_000)).toBe(26);
    expect(publicNationPower(3, 12, 12_000)).toBe(26);
    const source = [{ ...rows[0]!, gold: 10000, rice: 20000, population: 30000, crew: 40000 }];
    expect(rankNations(source, 'power')).toEqual([{ ...rows[0]!, rank: 1, value: 100 }]);
    expect(rankNations([], 'power')).toEqual([]);
  });

  it('도시·장수 수를 아는 상대도 같은 기술 구간 안의 원값을 구별할 수 없다', () => {
    const powers = [1_000, 1_234, 1_999].map((tech) => publicNationPower(3, 12, tech));
    expect(new Set(powers).size).toBe(1);
    expect(powers[0]! - 3 - 12).toBe(1);
  });
});
