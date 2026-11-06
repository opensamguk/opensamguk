import { expect, it } from 'vitest';
import { loadInitialWorld, resolveWorldResourceSelection } from './resources';
const selection = {
  map: 'integration',
  scenario: 'integration191',
  unitSet: 'basic',
  statRules: 'five-stats',
  portraitMap: '191-map',
};
it('AC-P2-27 파일 경계는 2판을 파일 읽기 전에 거부한다', async () => {
  await expect(
    loadInitialWorld({ ...selection, map: 'integration@2', seed: 'resource-version' }, new URL('file:///nonexistent/')),
  ).rejects.toThrow('게시된 판으로 생성하세요');
  expect(resolveWorldResourceSelection({ map: 'san10@2', scenario: 'san10-191@2' })).toEqual({
    map: 'san10@2',
    scenario: 'san10-191@2',
    unitSet: 'basic',
    statRules: 'five-stats',
    portraitMap: '191-map',
  });
});
