import { describe, expect, it } from 'vitest';
import { formatGameDate, nextMonth } from './gameDate';

describe('게임 달력', () => {
  it('12월 다음은 다음 해 1월이다', () => {
    expect(nextMonth({ year: 191, month: 12 })).toEqual({ year: 192, month: 1 });
  });

  it('그 밖의 달은 같은 해 다음 달이다', () => {
    expect(nextMonth({ year: 191, month: 1 })).toEqual({ year: 191, month: 2 });
  });

  it('연월을 화면 문자열로 바꾼다', () => {
    expect(formatGameDate({ year: 191, month: 3 })).toBe('191년 3월');
  });
});
