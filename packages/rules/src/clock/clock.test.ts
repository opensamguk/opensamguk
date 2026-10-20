import { describe, expect, it } from 'vitest';
import {
  checkpointClock,
  endClock,
  nowTick,
  pauseClock,
  resumeClock,
  startClock,
  toGameDate,
  type Clock,
} from './clock';
const initial: Clock = { status: 'PREOPEN', clockTick: 0, clockAnchorAt: null, turnTermMinutes: 10 };

describe('AC-M1-04 게임 시계', () => {
  it('10분 간격에서 25분은 25000 tick과 두 달이다', () => {
    const clock = startClock(initial, 0);
    expect(nowTick(clock, 25 * 60_000)).toBe(25_000);
    expect(toGameDate(191, 25_000)).toEqual({ year: 191, month: 3 });
    expect(toGameDate(191, 120_000)).toEqual({ year: 192, month: 1 });
  });
  it('정지 한 시간은 흐르지 않고 재개 뒤 5분만 더한다', () => {
    const paused = pauseClock(startClock(initial, 0), 600_000);
    expect(nowTick(paused, 4_200_000)).toBe(10_000);
    expect(nowTick(resumeClock(paused, 4_200_000), 4_500_000)).toBe(15_000);
  });
  it('저장된 tick보다 역행하지 않고 자투리 tick도 보존한다', () => {
    const clock = checkpointClock(startClock(initial, 100), 165);
    expect(nowTick(clock, 50)).toBe(clock.clockTick);
    expect(nowTick(clock, 220)).toBe(2);
  });
  it('아직 저장하지 않은 관측 tick도 역행하지 않고 원래 시각부터 이어 간다', () => {
    const running = startClock(initial, 0);
    const observed = nowTick(running, 600_000);
    const checkpoint = checkpointClock(running, 300_000, observed);
    expect(checkpoint).toMatchObject({ clockTick: 10_000, clockAnchorAt: 600_000 });
    expect(nowTick(checkpoint, 600_000)).toBe(10_000);
    expect(nowTick(checkpoint, 660_000)).toBe(11_000);
    expect(checkpointClock({ ...checkpoint, status: 'PAUSED' }, 900_000, 20_000).clockTick).toBe(10_000);
  });
  it('금지된 전환과 잘못된 값을 거부한다', () => {
    expect(() => pauseClock(initial, 0)).toThrow();
    const ended = endClock(startClock(initial, 0), 1000);
    expect(() => startClock(ended, 2000)).toThrow();
    expect(() => resumeClock(ended, 2000)).toThrow();
    expect(() => nowTick({ ...initial, turnTermMinutes: 0 }, 0)).toThrow();
  });
});
