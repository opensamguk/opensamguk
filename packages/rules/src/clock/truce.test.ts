import { describe, expect, it } from 'vitest';
import {
  checkpointClock,
  effectiveElapsed,
  endClock,
  inTruce,
  nowTick,
  pauseClock,
  resumeClock,
  startClock,
  timeAtTick,
  truceMsBetween,
  truceSchema,
  truceWindow,
  type Clock,
  type Truce,
} from './clock';

const at = (value: string) => Date.parse(`2026-${value}Z`);
const overnight: Truce = { utcOffsetMinutes: 0, startMinute: 23 * 60, endMinute: 7 * 60 };
const clock = (anchor = '10-24T23:00:00', term = 60, truce: Truce | null = overnight): Clock => ({
  status: 'RUNNING',
  clockTick: 50_000,
  clockAnchorAt: at(anchor),
  turnTermMinutes: term,
  truce,
});

describe('T4-40 AC-P2-19 순수 휴전 시계', () => {
  it('R1~R3: 휴전 안에서는 멈추고 다음 칸은 휴전 뒤의 유효 경과로 계산한다', () => {
    expect(timeAtTick(clock(), 60_000)).toBe(at('10-25T08:00:00'));
    const earlier = clock('10-24T22:00:00');
    expect([50_000, 60_000, 70_000, 80_000].map((tick) => timeAtTick(earlier, tick))).toEqual([
      at('10-24T22:00:00'),
      at('10-24T23:00:00'),
      at('10-25T08:00:00'),
      at('10-25T09:00:00'),
    ]);
    expect(['10-25T06:59:59.994', '10-25T07:30:00', '10-25T08:00:00'].map((t) => nowTick(clock(), at(t)))).toEqual([
      50_000, 55_000, 60_000,
    ]);
  });
  it('R4~R6: 재시작 경과에서 휴전을 빼고 체크포인트의 자투리 tick을 보존한다', () => {
    const half = clock('10-24T22:30:00');
    expect(nowTick(half, at('10-24T23:30:00'))).toBe(55_000);
    expect(nowTick(half, at('10-25T07:30:00'))).toBe(60_000);
    expect(timeAtTick(half, 60_000)).toBe(at('10-25T07:30:00'));
    expect(nowTick(clock('10-24T22:00:00'), at('10-25T09:00:00'))).toBe(80_000);
    const saved = checkpointClock(half, at('10-25T07:20:00'));
    expect(saved).toMatchObject({ clockTick: 58_333, clockAnchorAt: at('10-25T07:19:59.880') });
    expect(nowTick(saved, at('10-25T07:50:00'))).toBe(63_333);
    expect(nowTick(saved, at('10-25T07:50:00'))).toBe(nowTick(half, at('10-25T07:50:00')));
  });
  it('R7~R10: KST·휴전 시작 순간·휴전 안 기준점·지난 칸을 구분한다', () => {
    const kst = clock('10-24T15:55:00', 10, { utcOffsetMinutes: 540, startMinute: 60, endMinute: 420 });
    expect([60_000, 70_000, 80_000].map((tick) => timeAtTick(kst, tick))).toEqual([
      at('10-24T22:05:00'),
      at('10-24T22:15:00'),
      at('10-24T22:25:00'),
    ]);
    expect(timeAtTick(clock('10-24T22:50:00', 10), 60_000)).toBe(at('10-24T23:00:00'));
    const inside = clock('10-25T03:00:00');
    expect(nowTick(inside, at('10-25T06:00:00'))).toBe(50_000);
    expect(timeAtTick(inside, 60_000)).toBe(at('10-25T08:00:00'));
    expect(timeAtTick(clock(), 40_000)).toBe(at('10-24T22:00:00'));
  });
  it('반열린 경계와 다음 휴전 안내를 정확히 구분한다', () => {
    expect(inTruce(at('10-24T22:59:59.999'), overnight)).toBe(false);
    expect(inTruce(at('10-24T23:00:00'), overnight)).toBe(true);
    expect(inTruce(at('10-25T06:59:59.999'), overnight)).toBe(true);
    expect(inTruce(at('10-25T07:00:00'), overnight)).toBe(false);
    expect(truceWindow(at('10-25T03:00:00'), overnight)).toEqual({
      active: true,
      endsAt: at('10-25T07:00:00'),
      nextStartsAt: at('10-25T23:00:00'),
    });
    expect(truceWindow(at('10-25T07:00:00'), overnight)).toEqual({
      active: false,
      endsAt: null,
      nextStartsAt: at('10-25T23:00:00'),
    });
    expect(truceMsBetween(at('10-24T23:00:00'), at('10-25T07:00:00'), overnight)).toBe(8 * 3_600_000);
    expect(truceMsBetween(1, 0, overnight)).toBe(0);
    expect(effectiveElapsed(1, 0, null)).toBe(0);
  });
  it.each([-720, 0, 540, 840])('UTC 오프셋 %i에서 닫힌 식을 독립 분 단위 합산과 비교한다', (offset) => {
    for (const [start, end] of [
      [0, 1],
      [1, 0],
      [60, 420],
      [1380, 420],
    ]) {
      const truce: Truce = { utcOffsetMinutes: offset, startMinute: start!, endMinute: end! };
      const from = -2 * 86_400_000 - 123 * 60_000;
      const to = from + 5 * 86_400_000;
      let total = 0;
      for (let minute = from / 60_000; minute < to / 60_000; minute++) {
        const local = (((minute + offset) % 1440) + 1440) % 1440;
        const inside = start! < end! ? local >= start! && local < end! : local >= start! || local < end!;
        if (inside) total += 60_000;
      }
      expect(truceMsBetween(from, to, truce)).toBe(total);
      expect(effectiveElapsed(from, to, truce)).toBe(to - from - total);
      expect(truceMsBetween(from, from + 86_400_000, truce)).toBe(total / 5);
    }
  });
  it('역변환이 여러 날·음수 시각·최단/최장 휴전에서도 목표 tick의 가장 이른 시각이다', () => {
    for (const truce of [overnight, { utcOffsetMinutes: 840, startMinute: 1, endMinute: 0 }]) {
      for (const anchor of [-3 * 86_400_000, -1, 0, at('10-24T22:57:00')]) {
        const source = { ...clock(), clockAnchorAt: anchor, truce };
        let previous = anchor;
        for (const delta of [1, 7, 100, 10_000, 50_000, 1_000_000]) {
          const target = source.clockTick + delta;
          const time = timeAtTick(source, target);
          expect(time).toBeGreaterThanOrEqual(previous);
          expect(nowTick(source, time)).toBe(target);
          expect(nowTick(source, time - 1)).toBeLessThan(target);
          previous = time;
        }
      }
    }
  });
  it('휴전 안의 정지·재개·종료와 저장 최소 tick도 같은 시계를 쓴다', () => {
    const source = clock('10-24T22:30:00');
    const paused = pauseClock(source, at('10-25T03:00:00'));
    expect(paused.clockTick).toBe(55_000);
    const resumed = resumeClock(paused, at('10-25T04:00:00'));
    expect(nowTick(resumed, at('10-25T06:00:00'))).toBe(55_000);
    expect(nowTick(resumed, at('10-25T07:30:00'))).toBe(60_000);
    expect(endClock(resumed, at('10-25T06:00:00')).clockTick).toBe(55_000);
    const saved = checkpointClock(source, at('10-25T03:00:00'), 60_000);
    expect(saved).toMatchObject({ clockTick: 60_000, clockAnchorAt: at('10-25T07:30:00') });
    expect(nowTick(saved, at('10-25T07:00:00'))).toBe(60_000);
    expect(startClock({ ...source, status: 'PREOPEN', clockAnchorAt: null }, at('10-25T04:00:00')).clockAnchorAt).toBe(
      at('10-25T04:00:00'),
    );
  });
  it('R11: 끈 시계 2000개와 가속 시계는 기존 직선 식을 보존한다', () => {
    for (let i = 0; i < 2000; i++) {
      const source: Clock & { clockAnchorAt: number } = {
        ...clock(),
        truce: null,
        clockAnchorAt: -123_456_789 + i * 765_431,
        clockTick: i * 13,
        turnTermMinutes: 1 + (i % 1440),
      };
      if (i % 2 === 0) delete source.truce;
      const now = source.clockAnchorAt + (i - 1000) * 123_457;
      const tick =
        source.clockTick + Math.max(0, Math.floor((now - source.clockAnchorAt) / (6 * source.turnTermMinutes)));
      expect(nowTick(source, now)).toBe(tick);
      expect(checkpointClock(source, now).clockAnchorAt).toBe(
        source.clockAnchorAt + ((tick - source.clockTick) * source.turnTermMinutes * 60_000) / 10_000,
      );
      const target = source.clockTick + 10_000;
      expect(timeAtTick(source, target)).toBe(
        source.clockAnchorAt + (target - source.clockTick) * 6 * source.turnTermMinutes,
      );
    }
    const accelerated = { ...clock(), clockMode: 'ACCELERATED' as const };
    expect(nowTick(accelerated, at('10-27T08:00:00'))).toBe(50_000);
    expect(checkpointClock(accelerated, at('10-27T08:00:00'))).toEqual(accelerated);
    expect(timeAtTick(accelerated, 60_000)).toBe(at('10-25T00:00:00'));
  });
  it('R12: 설정의 잘못된 경계와 표현할 수 없는 계산 결과를 거부한다', () => {
    for (const patch of [
      { startMinute: 420 },
      { startMinute: 1440 },
      { endMinute: -1 },
      { utcOffsetMinutes: 900 },
      { utcOffsetMinutes: -721 },
      { endMinute: 1.5 },
      { extra: true },
    ])
      expect(truceSchema.safeParse({ ...overnight, ...patch }).success).toBe(false);
    expect(() => timeAtTick({ ...clock(), clockAnchorAt: null }, 60_000)).toThrow();
    expect(() => timeAtTick(clock(), -1)).toThrow();
    expect(() =>
      timeAtTick(
        clock('10-24T23:00:00', 2_147_483_647, { utcOffsetMinutes: 0, startMinute: 1, endMinute: 0 }),
        350_000,
      ),
    ).toThrow();
    expect(() => truceWindow(8_640_000_000_000_000, overnight)).toThrow();
    expect(() => effectiveElapsed(-8_640_000_000_000_000, 8_640_000_000_000_000, null)).toThrow();
  });
});
