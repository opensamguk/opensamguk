import { describe, expect, it } from 'vitest';
import { seasonOutcome, unifiedNation } from './season';
import { nowTick, checkpointClock } from './clock/clock';
import type { WorldState } from './model/world';

const state = (owners: (number | null)[], nations = [1]) =>
  ({
    nations: Object.fromEntries(nations.map((id) => [id, { id }])),
    cities: Object.fromEntries(owners.map((nationId, cityKey) => [cityKey, { cityKey, nationId }])),
  }) as WorldState;

describe('AC-M1-21 순수 기수 종료', () => {
  it('한 국가가 모든 도시를 소유한 경우만 통일이다', () => {
    expect(unifiedNation(state([1, 1]))).toBe(1);
    expect(seasonOutcome(state([1, 1]), { endYear: null })).toEqual({ reason: 'UNIFIED', winnerNationId: 1 });
    for (const candidate of [state([1, null]), state([1, 1], [1, 2]), state([]), state([], [])])
      expect(seasonOutcome(candidate, { endYear: null })).toBeNull();
  });
  it('종료 연도 12월 정산 뒤만 승자 없이 끝난다', () => {
    const candidate = state([1, 2], [1, 2]);
    for (const settled of [undefined, { year: 299, month: 12 }, { year: 300, month: 11 }])
      expect(seasonOutcome(candidate, { endYear: 300, ...(settled ? { settled } : {}) })).toBeNull();
    expect(seasonOutcome(candidate, { endYear: 300, settled: { year: 300, month: 12 } })).toEqual({
      reason: 'END_YEAR',
      winnerNationId: null,
    });
    expect(seasonOutcome(candidate, { endYear: null, settled: { year: 300, month: 12 } })).toBeNull();
    expect(seasonOutcome(state([1]), { endYear: 300, settled: { year: 300, month: 12 } })?.reason).toBe('UNIFIED');
  });
  it('가속·종료 시계는 벽시계와 최소 tick으로 외삽하지 않는다', () => {
    const clock = {
      status: 'RUNNING' as const,
      clockMode: 'ACCELERATED' as const,
      clockTick: 123,
      clockAnchorAt: 0,
      turnTermMinutes: 1,
    };
    expect(nowTick(clock, 999999)).toBe(123);
    expect(checkpointClock(clock, 999999, 999)).toEqual(clock);
    expect(nowTick({ ...clock, status: 'ENDED', clockMode: 'REALTIME' }, 999999)).toBe(123);
  });
});
