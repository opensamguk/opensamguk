import { z } from 'zod';
import type { Clock } from './clock';
import { TICKS_PER_MONTH } from './constants';

export const truceSchema = z
  .strictObject({
    utcOffsetMinutes: z.number().int().min(-720).max(840),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(0).max(1439),
  })
  .refine((value) => value.startMinute !== value.endMinute, '휴전 시작과 종료는 달라야 합니다.');
export type Truce = z.infer<typeof truceSchema>;

const DAY = 86_400_000;
const DATE_LIMIT = 8_640_000_000_000_000;
function safe(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError('휴전 계산의 안전 정수 범위를 넘었습니다.');
  return value;
}
function timestamp(value: number): number {
  if (Math.abs(safe(value)) > DATE_LIMIT) throw new RangeError('휴전 시각의 저장 범위를 넘었습니다.');
  return value;
}
function period(truce: Truce) {
  const { startMinute, endMinute, utcOffsetMinutes } = truceSchema.parse(truce);
  return {
    shift: (startMinute - utcOffsetMinutes) * 60_000,
    length: ((endMinute - startMinute + 1440) % 1440) * 60_000,
  };
}
function coordinate(at: number, shift: number) {
  const elapsed = safe(timestamp(at) - shift);
  const days = Math.floor(elapsed / DAY);
  return { days, rest: elapsed - days * DAY };
}
function totalTruce(at: number, shift: number, length: number) {
  const { days, rest } = coordinate(at, shift);
  return safe(days * length + Math.min(rest, length));
}

export function truceMsBetween(from: number, to: number, truce: Truce): number {
  timestamp(from);
  timestamp(to);
  const { shift, length } = period(truce);
  if (to <= from) return 0;
  return safe(totalTruce(to, shift, length) - totalTruce(from, shift, length));
}
export function effectiveElapsed(from: number, to: number, truce: Truce | null): number {
  timestamp(from);
  timestamp(to);
  if (to <= from) return 0;
  return safe(safe(to - from) - (truce === null ? 0 : truceMsBetween(from, to, truce)));
}
export function inTruce(at: number, truce: Truce): boolean {
  const { shift, length } = period(truce);
  return coordinate(at, shift).rest < length;
}
export function truceWindow(at: number, truce: Truce) {
  const { shift, length } = period(truce);
  const { days, rest } = coordinate(at, shift);
  const active = rest < length;
  return {
    active,
    endsAt: active ? timestamp(shift + days * DAY + length) : null,
    nextStartsAt: timestamp(shift + (days + 1) * DAY),
    nextEndsAt: timestamp(shift + (days + 1) * DAY + length),
  };
}

export function timeAtTick(clock: Clock, targetTick: number): number {
  if (
    !Number.isSafeInteger(targetTick) ||
    targetTick < 0 ||
    !Number.isSafeInteger(clock.clockTick) ||
    clock.clockTick < 0 ||
    !Number.isSafeInteger(clock.turnTermMinutes) ||
    clock.turnTermMinutes < 1 ||
    clock.clockAnchorAt === null
  )
    throw new Error('잘못된 예정 시각의 시계 값입니다.');
  const anchor = timestamp(clock.clockAnchorAt);
  const need = safe((targetTick - clock.clockTick) * safe((clock.turnTermMinutes * 60_000) / TICKS_PER_MONTH));
  if (need <= 0 || clock.truce == null || clock.clockMode === 'ACCELERATED') return timestamp(anchor + need);
  const { shift, length } = period(clock.truce);
  const activePerDay = DAY - length;
  const target = safe(anchor - shift - totalTruce(anchor, shift, length) + need);
  const days = Math.floor(target / activePerDay);
  const rest = target - days * activePerDay;
  // 유효 경과가 평평한 휴전 구간에서는 시작 순간이 가장 이른 해다.
  return timestamp(shift + days * DAY + (rest === 0 ? 0 : length + rest));
}
