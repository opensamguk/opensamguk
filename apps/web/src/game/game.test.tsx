// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DUE_RETRY_DELAYS_MS, formatRemaining, remainingSeconds, useTurnCountdown } from './countdown';
import { errorCode, retryUnlessClientError } from './errors';
import { formatYearMonth, personalLogDate, tickDate } from './gameDate';
import { commandName, officerName } from './names';

afterEach(cleanup);

describe('남은 시간 계산', () => {
  it('서버 시각까지 남은 초를 올림하고 지나면 0', () => {
    const at = '2026-10-21T00:01:00.000Z';
    expect(remainingSeconds(at, Date.parse('2026-10-21T00:00:00.000Z'))).toBe(60);
    expect(remainingSeconds(at, Date.parse('2026-10-21T00:00:59.001Z'))).toBe(1);
    expect(remainingSeconds(at, Date.parse('2026-10-21T00:02:00.000Z'))).toBe(0);
    expect(remainingSeconds(null, 0)).toBeNull();
    expect(remainingSeconds('잘못된 값', 0)).toBeNull();
  });

  it('분:초, 한 시간이 넘으면 시:분:초', () => {
    expect(formatRemaining(5)).toBe('0:05');
    expect(formatRemaining(125)).toBe('2:05');
    expect(formatRemaining(3_725)).toBe('1:02:05');
  });
});

describe('useTurnCountdown (시계 주입)', () => {
  const start = Date.parse('2026-10-21T00:00:00.000Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1초마다 줄고 0초가 되는 순간 한 번만 다시 조회한다', () => {
    const onDue = vi.fn();
    const at = new Date(start + 3_000).toISOString();
    const { result } = renderHook(() => useTurnCountdown(at, onDue, () => Date.now()));
    expect(result.current.seconds).toBe(3);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(result.current.seconds).toBe(2);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(result.current.seconds).toBe(1);
    expect(onDue).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1_000));
    expect(result.current).toEqual({ seconds: 0, waiting: true });
    expect(onDue).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(4_000));
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it('서버가 같은 시각을 계속 주면 간격을 늘려 몇 번만 더 묻고 멈춘다', () => {
    const onDue = vi.fn();
    const at = new Date(start).toISOString();
    renderHook(() => useTurnCountdown(at, onDue, () => Date.now()));
    expect(onDue).toHaveBeenCalledTimes(1);
    let elapsed = 0;
    for (const delay of DUE_RETRY_DELAYS_MS) {
      act(() => void vi.advanceTimersByTime(delay - 1_000));
      elapsed += delay - 1_000;
      const before = onDue.mock.calls.length;
      act(() => void vi.advanceTimersByTime(1_000));
      elapsed += 1_000;
      expect(onDue.mock.calls.length).toBe(before + 1);
    }
    expect(onDue).toHaveBeenCalledTimes(1 + DUE_RETRY_DELAYS_MS.length);
    act(() => void vi.advanceTimersByTime(10 * 60_000));
    expect(onDue).toHaveBeenCalledTimes(1 + DUE_RETRY_DELAYS_MS.length);
    expect(elapsed).toBe(DUE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
  });

  it('새 시각이 오면 처음부터 다시 센다', () => {
    const onDue = vi.fn();
    const first = new Date(start + 1_000).toISOString();
    const { result, rerender } = renderHook(({ at }) => useTurnCountdown(at, onDue, () => Date.now()), {
      initialProps: { at: first },
    });
    act(() => void vi.advanceTimersByTime(1_000));
    expect(onDue).toHaveBeenCalledTimes(1);
    rerender({ at: new Date(start + 61_000).toISOString() });
    expect(result.current.seconds).toBe(60);
    act(() => void vi.advanceTimersByTime(59_000));
    expect(onDue).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(onDue).toHaveBeenCalledTimes(2);
  });

  it('정지·개시 전(null)이면 타이머를 돌리지 않는다', () => {
    const onDue = vi.fn();
    const { result } = renderHook(() => useTurnCountdown(null, onDue, () => Date.now()));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current).toEqual({ seconds: null, waiting: false });
    expect(onDue).not.toHaveBeenCalled();
  });
});

describe('기록 연월', () => {
  // 월드 요약: 191년 3월, nowTick 25_000, 한 달 10_000 tick (turnTerm 60분, msPerTick 360)
  const clock = { gameDate: { year: 191, month: 3 }, nowTick: 25_000, msPerTick: 360, turnTermMinutes: 60 };
  it('tick을 요약의 현재 연월 기준으로 바꾼다', () => {
    expect(tickDate(25_000, clock)).toEqual({ year: 191, month: 3 });
    expect(tickDate(10_000, clock)).toEqual({ year: 191, month: 2 });
    expect(tickDate(0, clock)).toEqual({ year: 191, month: 1 });
    expect(tickDate(120_000, clock)).toEqual({ year: 192, month: 1 });
    expect(formatYearMonth(tickDate(9_999, clock))).toBe('191년 1월');
    expect(formatYearMonth(null)).toBe('—');
  });

  // 종료 연도 도달 월드: 시작 연도 300, 한 달 10_000 tick (turnTerm 1분, msPerTick 6), 결정 tick 120_000, 결과 300년 12월.
  // 국가 기록은 tickDate를 그대로 쓴다. 지금 값이며 개인 로그 수리 뒤에도 같아야 한다.
  it('국가 기록 연월은 종료 직전과 종료 뒤 요약에서 지금 값을 지킨다', () => {
    const running = { gameDate: { year: 300, month: 12 }, nowTick: 119_999, msPerTick: 6, turnTermMinutes: 1 };
    const ended = { gameDate: { year: 300, month: 12 }, nowTick: 120_000, msPerTick: 6, turnTermMinutes: 1 };
    expect(formatYearMonth(tickDate(110_000, running))).toBe('300년 12월');
    expect(formatYearMonth(tickDate(110_000, ended))).toBe('300년 11월');
    expect(formatYearMonth(tickDate(120_000, ended))).toBe('300년 12월');
  });
});

describe('개인 로그 연월 (T1-27 후속)', () => {
  // synthetic 시계다. 한 달 10_000 tick (turnTerm 1분, msPerTick 6). 실제 API나 DB 값이 아니다.
  const endYear = { startYear: 300, msPerTick: 6, turnTermMinutes: 1 };
  const unified = { startYear: 191, msPerTick: 6, turnTermMinutes: 1 };

  it('종료 연도 월드의 마지막 로그는 300년 12월이다', () => {
    expect(formatYearMonth(personalLogDate(119_999, endYear))).toBe('300년 12월');
  });

  it('달 경계 앞은 앞 달, 경계와 그 뒤는 다음 달이다', () => {
    expect(formatYearMonth(personalLogDate(109_999, endYear))).toBe('300년 11월');
    expect(formatYearMonth(personalLogDate(110_000, endYear))).toBe('300년 12월');
    expect(formatYearMonth(personalLogDate(110_001, endYear))).toBe('300년 12월');
  });

  it('tick 0은 시작 연도 1월이다', () => {
    expect(formatYearMonth(personalLogDate(0, endYear))).toBe('300년 1월');
  });

  it('천하통일 월드는 정산 경계 직전 로그와 월중 로그를 각각 그 tick의 달로 쓴다', () => {
    expect(formatYearMonth(personalLogDate(19_999, unified))).toBe('191년 2월');
    expect(formatYearMonth(personalLogDate(25_000, unified))).toBe('191년 3월');
  });

  it('tick 길이를 셀 수 없는 시계는 연월을 쓰지 않는다', () => {
    expect(personalLogDate(119_999, { ...endYear, msPerTick: 0 })).toBeNull();
    expect(personalLogDate(119_999, { ...endYear, turnTermMinutes: 0 })).toBeNull();
    expect(formatYearMonth(personalLogDate(119_999, { ...endYear, msPerTick: 0 }))).toBe('—');
  });
});

describe('이름표', () => {
  it('명령 이름과 직책', () => {
    expect(commandName('farm')).toBe('농지 개간');
    expect(commandName('없는_키')).toBe('없는_키');
    expect(officerName(12)).toBe('군주');
    expect(officerName(0)).toBe('재야');
    expect(officerName(0, true)).toBe('일반');
    expect(officerName(5)).toBe('관직 5단계');
  });
});

describe('오류 코드', () => {
  it('없는 대상은 재시도하지 않고 연결 오류는 한 번 다시 묻는다', () => {
    const notFound = new TRPCClientError('없음', { result: { error: { data: { code: 'NOT_FOUND' } } } } as never);
    expect(errorCode(notFound)).toBe('NOT_FOUND');
    expect(retryUnlessClientError(0, notFound)).toBe(false);
    expect(retryUnlessClientError(0, new Error('네트워크'))).toBe(true);
    expect(retryUnlessClientError(1, new Error('네트워크'))).toBe(false);
  });
});
