import { describe, expect, it } from 'vitest';
import { operationIdle, operationMonths, operationTargetAt, operationTick } from './operation';
import type { nextTurnAt } from '../queries';

describe('작전 응답 경계', () => {
  it('BigInt 목표를 Int32 제한 없이 정확한 number로 읽는다', () => {
    expect(operationTick(2147490000n)).toBe(2147490000);
    expect(operationTick(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => operationTick(9007199254740992n)).toThrow();
    expect(() => operationTick(-1n)).toThrow();
  });

  it('멀리 떨어진 nextTurnTick도 표시 월 반복을 31회 안에 묶는다', () => {
    const months = operationMonths({ year: 191, month: 12 }, { year: 999999999, month: 12 }, [
      { year: 1000000, month: 8 },
    ]);
    expect(months).toHaveLength(31);
    expect(months[0]).toEqual({ year: 191, month: 12 });
    expect(months.at(-1)).toEqual({ year: 194, month: 6 });
  });

  it('목표 다음 달, 마지막 칸 달 중 이른 달에서 끝내고 참여자가 없거나 목표가 지나면 빈 배열이다', () => {
    const current = { year: 191, month: 12 };
    expect(operationMonths(current, { year: 192, month: 1 }, [{ year: 193, month: 1 }])).toEqual([
      current,
      { year: 192, month: 1 },
      { year: 192, month: 2 },
    ]);
    expect(operationMonths(current, { year: 193, month: 1 }, [{ year: 192, month: 1 }])).toHaveLength(2);
    expect(operationMonths(current, { year: 191, month: 10 }, [{ year: 193, month: 1 }])).toEqual([]);
    expect(operationMonths(current, { year: 193, month: 1 }, [])).toEqual([]);
  });

  it('safe 연도 끝에서도 전체 연도에 12를 곱하지 않는다', () => {
    const year = Number.MAX_SAFE_INTEGER - 10;
    const months = operationMonths({ year, month: 12 }, { year: year + 5, month: 1 }, [{ year: year + 5, month: 2 }]);
    expect(months.at(-1)).toEqual({ year: year + 3, month: 6 });
    expect(months).toHaveLength(31);
  });

  it('활동 null과 NPC는 판정하지 않고 숫자는 정확히 14일 뒤까지 false다', () => {
    const threshold = (14 * 1440 * 10000) / 30;
    expect(operationIdle({ userId: 'human', lastActiveTick: null }, threshold + 1, 30)).toBe(false);
    expect(operationIdle({ userId: null, lastActiveTick: 0 }, threshold + 1, 30)).toBe(false);
    expect(operationIdle({ userId: 'human', lastActiveTick: 0 }, threshold, 30)).toBe(false);
    expect(operationIdle({ userId: 'human', lastActiveTick: 0 }, threshold + 1, 30)).toBe(true);
  });

  it('목표가 Date 표현 밖이어도 생성 범위를 좁히지 않고 시각만 null이다', () => {
    const world = {
      status: 'RUNNING',
      clockMode: 'REALTIME',
      clockAnchorAt: new Date(0),
      clockTick: 0,
      turnTermMinutes: 30,
    } as Parameters<typeof nextTurnAt>[0];
    expect(operationTargetAt(world, 10000)).toBe('1970-01-01T00:30:00.000Z');
    expect(operationTargetAt(world, Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(operationTargetAt({ ...world, status: 'PAUSED' }, 10000)).toBeNull();
  });
});
