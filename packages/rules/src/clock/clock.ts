import { TICKS_PER_MONTH } from './constants';

export type ClockStatus = 'PREOPEN' | 'RUNNING' | 'PAUSED' | 'ENDED';
export interface Clock {
  status: ClockStatus;
  clockTick: number;
  clockAnchorAt: number | null;
  turnTermMinutes: number;
}

function validate(clock: Clock, now: number) {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(clock.clockTick) ||
    clock.clockTick < 0 ||
    !Number.isSafeInteger(clock.turnTermMinutes) ||
    clock.turnTermMinutes < 1
  )
    throw new Error('잘못된 시계 값입니다.');
  if (clock.status === 'RUNNING' && (clock.clockAnchorAt === null || !Number.isSafeInteger(clock.clockAnchorAt))) {
    throw new Error('실행 중인 시계에 기준 시각이 없습니다.');
  }
}

export function nowTick(clock: Clock, now: number): number {
  validate(clock, now);
  if (clock.status !== 'RUNNING') return clock.clockTick;
  const msPerTick = (clock.turnTermMinutes * 60_000) / TICKS_PER_MONTH;
  return clock.clockTick + Math.max(0, Math.floor((now - clock.clockAnchorAt!) / msPerTick));
}

// Preserve fractional ticks when saving a running clock checkpoint.
export function checkpointClock(clock: Clock, now: number, minimumTick = 0): Clock {
  if (!Number.isSafeInteger(minimumTick) || minimumTick < 0) throw new Error('잘못된 최소 tick입니다.');
  const tick = Math.max(minimumTick, nowTick(clock, now));
  if (clock.status !== 'RUNNING') return { ...clock };
  return {
    ...clock,
    clockTick: tick,
    clockAnchorAt: clock.clockAnchorAt! + ((tick - clock.clockTick) * clock.turnTermMinutes * 60_000) / TICKS_PER_MONTH,
  };
}

export function startClock(clock: Clock, now: number): Clock {
  validate(clock, now);
  if (clock.status !== 'PREOPEN') throw new Error('PREOPEN 월드만 시작할 수 있습니다.');
  return { ...clock, status: 'RUNNING', clockAnchorAt: now };
}

export function pauseClock(clock: Clock, now: number): Clock {
  if (clock.status !== 'RUNNING') throw new Error('RUNNING 월드만 일시정지할 수 있습니다.');
  return { ...clock, status: 'PAUSED', clockTick: nowTick(clock, now), clockAnchorAt: now };
}

export function resumeClock(clock: Clock, now: number): Clock {
  validate(clock, now);
  if (clock.status !== 'PAUSED') throw new Error('PAUSED 월드만 재개할 수 있습니다.');
  return { ...clock, status: 'RUNNING', clockAnchorAt: now };
}

export function endClock(clock: Clock, now: number): Clock {
  if (clock.status !== 'RUNNING') throw new Error('RUNNING 월드만 종료할 수 있습니다.');
  return { ...clock, status: 'ENDED', clockTick: nowTick(clock, now), clockAnchorAt: now };
}

export function toGameDate(startYear: number, tick: number) {
  if (!Number.isSafeInteger(startYear) || !Number.isSafeInteger(tick) || tick < 0)
    throw new Error('잘못된 게임 연월입니다.');
  const months = Math.floor(tick / TICKS_PER_MONTH);
  return { year: startYear + Math.floor(months / 12), month: (months % 12) + 1 };
}
