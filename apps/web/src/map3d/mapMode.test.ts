import { describe, expect, it } from 'vitest';
import { mapModeOfTier, showsSiteLabel } from './mapMode';

// INT-29 전체 지도 / 세부 모드: 확대 단계로 모드를 정하고, 모드에 따라 거점 이름판을 나눈다.
describe('mapMode', () => {
  it('확대 3단계부터 세부다', () => {
    expect(mapModeOfTier(1)).toBe('overview');
    expect(mapModeOfTier(2)).toBe('overview');
    expect(mapModeOfTier(3)).toBe('detail');
    expect(mapModeOfTier(4)).toBe('detail');
  });

  it('전체 지도는 큰 도시·관문 이름만, 세부는 모두, 고른·내 거점은 늘 보인다', () => {
    expect(showsSiteLabel('overview', { kind: 'CITY', level: 8 })).toBe(true);
    expect(showsSiteLabel('overview', { kind: 'CITY', level: 4 })).toBe(true);
    expect(showsSiteLabel('overview', { kind: 'CITY', level: 2 })).toBe(false);
    expect(showsSiteLabel('overview', { kind: 'PASS' })).toBe(true);
    expect(showsSiteLabel('overview', { kind: 'CITY', level: 2 }, true)).toBe(true);
    expect(showsSiteLabel('detail', { kind: 'CITY', level: 1 })).toBe(true);
  });
});
