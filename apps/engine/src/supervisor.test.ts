import { describe, expect, it } from 'vitest';
import { CRASH_LIMIT, CRASH_WINDOW_MS, recentCrashes, restartDelay } from './supervisor';

describe('감독 재시작 정책', () => {
  it('백오프는 1·2·4초로 늘고 60초에서 멈춘다', () => {
    expect(Array.from({ length: 9 }, (_, i) => restartDelay(i + 1))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });

  it('5분 창의 경계 밖 크래시는 제외하고 5회를 임계로 삼는다', () => {
    expect(CRASH_LIMIT).toBe(5);
    expect(recentCrashes([0, 1, 1000, CRASH_WINDOW_MS], CRASH_WINDOW_MS)).toEqual([1, 1000, CRASH_WINDOW_MS]);
    expect(recentCrashes([0, 1, 1000], CRASH_WINDOW_MS + 1000)).toEqual([]);
  });
});
