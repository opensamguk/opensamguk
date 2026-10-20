import { describe, expect, it } from 'vitest';
import { loadInitialWorld } from './resources';

describe('리소스 파일 로더', () => {
  it('군웅할거와 지도 리소스를 실제 파일에서 읽는다', async () => {
    const world = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'loader' });
    expect([world.cities.length, world.generals.length]).toEqual([94, 491]);
  });
  it('경로 이동을 포함한 리소스 ID를 거부한다', async () => {
    await expect(loadInitialWorld({ scenario: '../1030', map: 'che', seed: 'loader' })).rejects.toThrow('리소스 ID');
    await expect(loadInitialWorld({ scenario: '1030', map: '/che', seed: 'loader' })).rejects.toThrow('리소스 ID');
  });
});
