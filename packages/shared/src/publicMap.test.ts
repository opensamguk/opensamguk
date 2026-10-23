import { expect, it } from 'vitest';
import { publicMapConfig } from './publicMap';

it('공개 지도 기본 지연은 10분, 저장 간격은 5분이다', () => {
  expect(publicMapConfig({})).toEqual({ delayMinutes: 10, intervalMinutes: 5 });
  expect(publicMapConfig({ PUBLIC_MAP_DELAY_MINUTES: '1', PUBLIC_MAP_INTERVAL_MINUTES: '1' })).toEqual({
    delayMinutes: 1,
    intervalMinutes: 1,
  });
});
it('지연보다 긴 간격과 양의 정수가 아닌 값은 시작 설정 오류다', () => {
  expect(() => publicMapConfig({ PUBLIC_MAP_DELAY_MINUTES: '4' })).toThrow('간격');
  for (const key of ['PUBLIC_MAP_DELAY_MINUTES', 'PUBLIC_MAP_INTERVAL_MINUTES']) {
    for (const value of ['', ' ', '0', '-1', '0.5', 'Infinity', 'NaN', '1e2', '9007199254740991'])
      expect(() => publicMapConfig({ [key]: value })).toThrow(key);
  }
});
