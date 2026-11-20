import { describe, expect, it } from 'vitest';
import { cityConditions, seasonOf } from './cityConditions';

describe('도시 값으로 성 화면 상황 고르기', () => {
  it('재해 번호, 공격, 보급, 폐허, 민심, 치안을 상황으로 바꾼다', () => {
    expect(cityConditions({ state: 7 })).toEqual(['flood']);
    expect(cityConditions({ state: 43, supplied: false })).toEqual(['battle', 'unsupplied']);
    expect(cityConditions({ ruin: { level: 1 }, trust: 20, security: 30, securityMax: 100 })).toEqual([
      'ruin',
      'unhappy',
      'unsafe',
    ]);
    expect(cityConditions({ state: 1, trust: 90, security: 900, securityMax: 1000 })).toEqual(['harvest', 'loved']);
    expect(cityConditions(null)).toEqual([]);
  });
  it('게임 달로 계절을 정한다', () => {
    expect([1, 4, 7, 10, 12].map(seasonOf)).toEqual(['spring', 'summer', 'autumn', 'winter', 'winter']);
  });
});
