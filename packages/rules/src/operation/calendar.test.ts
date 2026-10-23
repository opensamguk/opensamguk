import { describe, expect, it } from 'vitest';
import { toGameDate } from '../clock/clock';
import { emptyTurns } from '../replay';
import { operationTargetTick, isPastOperationTarget } from './calendar';
import { calculateOperationTimeline } from './timeline';

describe('AC-M2-15 작전 목표 달력', () => {
  it.each([
    [191, 191, 1, 0],
    [191, 191, 2, 10000],
    [191, 191, 12, 110000],
    [191, 192, 1, 120000],
    [191, 195, 1, 480000],
    [200, 202, 3, 260000],
  ])('시작 %i년의 목표 %i년 %i월은 %i tick부터다', (startYear, year, month, expected) => {
    const tick = operationTargetTick(startYear!, year!, month!);
    expect(tick).toBe(expected);
    expect(toGameDate(startYear!, tick)).toEqual({ year, month });
    if (tick > 0) expect(toGameDate(startYear!, tick - 1)).not.toEqual({ year, month });
  });

  it.each([0, 1, 9999])('시작 달의 tick %i에서 같은 달 목표를 지난 달로 보지 않는다', (tick) => {
    expect(isPastOperationTarget(191, tick, 191, 1)).toBe(false);
  });

  it.each([110000, 110001, 119999])('12월의 tick %i에서 과거·현재·미래 연월을 나눈다', (tick) => {
    expect(isPastOperationTarget(191, tick, 191, 11)).toBe(true);
    expect(isPastOperationTarget(191, tick, 191, 12)).toBe(false);
    expect(isPastOperationTarget(191, tick, 192, 1)).toBe(false);
  });

  it('연도가 바뀌면 지난 12월이 과거가 된다', () => {
    expect(isPastOperationTarget(191, 119999, 191, 12)).toBe(false);
    expect(isPastOperationTarget(191, 120000, 191, 12)).toBe(true);
    expect(isPastOperationTarget(191, 129999, 192, 1)).toBe(false);
  });

  it('시작 전 연월은 과거로 판정하되 음수 목표 tick을 만들지 않는다', () => {
    expect(isPastOperationTarget(191, 0, 190, 12)).toBe(true);
    expect(() => operationTargetTick(191, 190, 12)).toThrow('범위');
  });

  it('30개월 밖 목표를 허용하고 기존 타임라인의 beyondWindow와 연결한다', () => {
    const deadlineTick = operationTargetTick(191, 195, 1);
    const result = calculateOperationTimeline({
      startYear: 191,
      nextTurnTick: 0,
      deadlineTick,
      targetCityKey: 2,
      current: { crew: 100, train: 70, atmos: 80 },
      min: { crew: 100, train: 70, atmos: 80 },
      turns: emptyTurns(),
    });
    expect(isPastOperationTarget(191, 0, 195, 1)).toBe(false);
    expect(result.beyondWindow).toBe(true);
    expect(result.cells[29]!.tick).toBeLessThan(deadlineTick);
    expect(result.verdict).toBe('MISSING');
  });

  it.each([
    [119999, 'READY'],
    [120000, 'LATE'],
  ] as const)('목표 첫 tick 120000과 출병 %i tick을 비교하면 %s다', (nextTurnTick, verdict) => {
    const turns = emptyTurns();
    turns[0] = { commandKey: 'attack', args: { cityKey: 2 } };
    const result = calculateOperationTimeline({
      startYear: 191,
      nextTurnTick,
      deadlineTick: operationTargetTick(191, 192, 1),
      targetCityKey: 2,
      current: { crew: 100, train: 70, atmos: 80 },
      min: { crew: 100, train: 70, atmos: 80 },
      turns,
    });
    expect(result.verdict).toBe(verdict);
  });

  it('현재 달 목표는 생성 가능하지만 그달 첫 tick 뒤의 출병은 늦다', () => {
    const tick = 10500;
    expect(isPastOperationTarget(191, tick, 191, 2)).toBe(false);
    const turns = emptyTurns();
    turns[0] = { commandKey: 'attack', args: { cityKey: 2 } };
    expect(
      calculateOperationTimeline({
        startYear: 191,
        nextTurnTick: tick,
        deadlineTick: operationTargetTick(191, 191, 2),
        targetCityKey: 2,
        current: { crew: 100, train: 70, atmos: 80 },
        min: { crew: 100, train: 70, atmos: 80 },
        turns,
      }).verdict,
    ).toBe('LATE');
  });

  it.each([0, 13, -1, 1.5, NaN, Infinity, '2', null, undefined])('잘못된 월 %s를 거부한다', (month) => {
    expect(() => operationTargetTick(191, 191, month as number)).toThrow('연월');
    expect(() => isPastOperationTarget(191, 0, 191, month as number)).toThrow('연월');
  });

  it.each([NaN, Infinity, 191.5, Number.MAX_SAFE_INTEGER + 1, '191', null, undefined])(
    '잘못된 연도 %s를 거부한다',
    (year) => {
      expect(() => operationTargetTick(year as number, 191, 1)).toThrow('연월');
      expect(() => operationTargetTick(191, year as number, 1)).toThrow('연월');
      expect(() => isPastOperationTarget(year as number, 0, 191, 1)).toThrow('연월');
      expect(() => isPastOperationTarget(191, 0, year as number, 1)).toThrow('연월');
    },
  );

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, undefined])(
    '잘못된 현재 tick %s를 거부한다',
    (tick) => {
      expect(() => isPastOperationTarget(191, tick as number, 191, 1)).toThrow();
    },
  );

  it('개월 수 또는 결과 tick이 safe integer를 넘으면 거부한다', () => {
    expect(() => operationTargetTick(0, Number.MAX_SAFE_INTEGER, 1)).toThrow('범위');
    expect(() => operationTargetTick(0, 100_000_000_000, 1)).toThrow('범위');
    const safeYear = Math.floor(Number.MAX_SAFE_INTEGER / 120000);
    const tick = operationTargetTick(0, safeYear, 1);
    expect(Number.isSafeInteger(tick)).toBe(true);
    expect(toGameDate(0, tick)).toEqual({ year: safeYear, month: 1 });
  });
});
