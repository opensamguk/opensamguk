import { describe, expect, it } from 'vitest';
import { damageStage, siegeLayout, siegeMaterial } from './siegeRules';

describe('공성 장면 고르기', () => {
  it('관은 언제나 치성 장면과 돌 성벽이다', () => {
    expect(siegeLayout({ key: 4, kind: 'PASS', level: null })).toBe('bastion');
    expect(siegeMaterial({ key: 4, kind: 'PASS', level: null })).toBe('stone');
  });

  it('도시 재질은 등급으로 고른다', () => {
    expect(siegeMaterial({ key: 1, kind: 'CITY', level: 8 })).toBe('stone');
    expect(siegeMaterial({ key: 1, kind: 'CITY', level: 6 })).toBe('brick');
    expect(siegeMaterial({ key: 1, kind: 'CITY', level: 5 })).toBe('earth');
  });

  it('손상 얼룩은 방어도가 깎인 만큼 0~6단계다', () => {
    expect(damageStage(1000, 1000)).toBe(0);
    expect(damageStage(999, 1000)).toBe(1);
    expect(damageStage(500, 1000)).toBe(3);
    expect(damageStage(0, 1000)).toBe(6);
  });
});
