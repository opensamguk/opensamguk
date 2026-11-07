import { expect, it } from 'vitest';
import { resolveWorldResourceSelection } from './resources';
it('AC-P2-27 2판 선택은 기본 칸을 채운 정규 키로 해석한다', () => {
  expect(resolveWorldResourceSelection({ map: 'san10@2', scenario: 'san10-191@2' })).toEqual({
    map: 'san10@2',
    scenario: 'san10-191@2',
    unitSet: 'basic',
    statRules: 'five-stats',
    portraitMap: '191-map',
  });
});
