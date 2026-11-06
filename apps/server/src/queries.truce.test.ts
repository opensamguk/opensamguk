import { expect, it } from 'vitest';
import { nextTurnAt, turnSchedule, worldClock, worldSummary } from './queries';

const at = (value: string) => Date.parse(`2026-${value}Z`);
const truce = { utcOffsetMinutes: 0, startMinute: 1380, endMinute: 420 };
function world() {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    name: '휴전 판',
    status: 'RUNNING' as const,
    clockMode: 'REALTIME' as const,
    endYear: null,
    result: null,
    startYear: 191,
    clockTick: 50_000,
    clockAnchorAt: new Date(at('10-24T22:00:00')),
    turnTermMinutes: 60,
    ruleFeatures: [] as string[],
    preset: null,
    runtimeOptions: { truce },
  };
}
it('AC-P2-19 서버30칸은 휴전을 건너고 첫 칸과 개별 예정 시각이 같다', () => {
  const row = world(),
    schedule = turnSchedule(row, 50_000)!;
  expect(schedule).toHaveLength(30);
  expect(schedule.slice(0, 4)).toEqual([
    '2026-10-24T22:00:00.000Z',
    '2026-10-24T23:00:00.000Z',
    '2026-10-25T08:00:00.000Z',
    '2026-10-25T09:00:00.000Z',
  ]);
  for (let slot = 0; slot < 30; slot++) expect(schedule[slot]).toBe(nextTurnAt(row, 50_000 + slot * 10_000));
  expect(nextTurnAt(row, 40_000)).toBe('2026-10-24T21:00:00.000Z');
});
it('AC-P2-19 요약은 유효 tick과 공개 휴전 상태만 내보낸다', () => {
  const row = world(),
    result = worldSummary(row, at('10-25T03:00:00'));
  expect(result.nowTick).toBe(60_000);
  expect(result.truce).toEqual({
    ...truce,
    active: true,
    endsAt: '2026-10-25T07:00:00.000Z',
    nextStartsAt: '2026-10-25T23:00:00.000Z',
    nextEndsAt: '2026-10-26T07:00:00.000Z',
  });
  expect(result).not.toHaveProperty('preset');
  expect(result).not.toHaveProperty('runtimeOptions');
  expect(worldClock(row).truce).toEqual(truce);
});
it('AC-P2-19 꺼진 월드는 기존 직선30칸과 null 휴전 상태를 유지한다', () => {
  const row = { ...world(), runtimeOptions: null },
    first = nextTurnAt(row, 60_000)!;
  expect(worldSummary(row, at('10-25T03:00:00')).truce).toBeNull();
  expect(turnSchedule(row, 60_000)).toEqual(
    Array.from({ length: 30 }, (_, slot) => new Date(Date.parse(first) + slot * 3_600_000).toISOString()),
  );
});
it('AC-P2-19 정지·종료·가속·기준점 없음은 예정 시각을 만들지 않는다', () => {
  const row = world();
  for (const patch of [
    { status: 'PAUSED' as const },
    { status: 'ENDED' as const },
    { clockMode: 'ACCELERATED' as const },
    { clockAnchorAt: null },
  ]) {
    expect(nextTurnAt({ ...row, ...patch }, 60_000)).toBeNull();
    expect(turnSchedule({ ...row, ...patch }, 60_000)).toBeNull();
  }
});
it('AC-P2-19 표현 불가능한 칸만 비우고 잘못된 저장 설정은 숨기지 않는다', () => {
  const row = {
    ...world(),
    turnTermMinutes: 2_147_483_647,
    runtimeOptions: { truce: { ...truce, startMinute: 1, endMinute: 0 } },
  };
  expect(turnSchedule(row, row.clockTick)![0]).toBe(row.clockAnchorAt.toISOString());
  expect(turnSchedule(row, row.clockTick)![1]).toBeNull();
  expect(nextTurnAt(row, 60_000)).toBeNull();
  expect(() =>
    turnSchedule({ ...world(), runtimeOptions: { truce: { ...truce, endMinute: 1380 } } }, 60_000),
  ).toThrow();
});
