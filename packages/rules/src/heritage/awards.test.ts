import { expect, it } from 'vitest';
import { TICKS_PER_MONTH } from '../clock/constants';
import { seasonHeritageAwards, type SeasonHeritageInput } from './awards';

function season(months: number): SeasonHeritageInput {
  return {
    reason: 'END_YEAR',
    winnerNationId: null,
    generals: [],
    endedSequence: months,
    activity: Array.from({ length: months }, (_, i) => ({
      userId: 'account-a',
      kind: 'turns.set',
      status: 'APPLIED',
      sequence: i + 1,
      tick: i * TICKS_PER_MONTH,
      result: {},
    })),
  };
}
it.each([
  [11, 0],
  [12, 1],
  [23, 1],
  [24, 2],
  [35, 2],
  [36, 3],
  [48, 3],
])('AC-P2-33 직접 활동 %i개월은 %i점이다', (months, points) => {
  expect(seasonHeritageAwards(season(months)).reduce((sum, award) => sum + award.total, 0)).toBe(points);
});
it('AC-P2-33 통일 소속에만 2점을 더하고 계정당 5점 이내로 정렬해 지급한다', () => {
  const state = season(36);
  state.reason = 'UNIFIED';
  state.winnerNationId = 2;
  state.generals = [
    { userId: 'account-z', nationId: 2 },
    { userId: 'account-a', nationId: 2 },
    { userId: 'account-loser', nationId: 1 },
    { userId: null, nationId: 2 },
  ];
  const before = structuredClone(state),
    awards = seasonHeritageAwards(state);
  expect(awards).toEqual([
    { userId: 'account-a', activityMonths: 36, activityPoints: 3, winPoints: 2, total: 5 },
    { userId: 'account-z', activityMonths: 0, activityPoints: 0, winPoints: 2, total: 2 },
  ]);
  expect(state).toEqual(before);
  expect(seasonHeritageAwards(state)).toEqual(awards);
});
it('AC-P2-33 기한 종료는 승자 소속 값이 있어도 통일 보상을 주지 않는다', () => {
  expect(
    seasonHeritageAwards({ ...season(12), winnerNationId: 2, generals: [{ userId: 'account-a', nationId: 2 }] }),
  ).toEqual([{ userId: 'account-a', activityMonths: 12, activityPoints: 1, winPoints: 0, total: 1 }]);
});
it('AC-P2-33 쉬었던 달 사이의 직접 활동도 기수 전체에서 합산한다', () => {
  const state = season(12);
  state.activity = state.activity.map((row, i) => ({ ...row, tick: 2 * i * TICKS_PER_MONTH }));
  expect(seasonHeritageAwards(state)).toMatchObject([{ activityMonths: 12, activityPoints: 1 }]);
});
it.each(['ADMIN_END', 'ADMIN_RESET'] as const)('AC-P2-33 %s는 활동·통일 보상을 새로 지급하지 않는다', (reason) => {
  expect(
    seasonHeritageAwards({
      ...season(36),
      reason,
      winnerNationId: 2,
      generals: [{ userId: 'account-a', nationId: 2 }],
    }),
  ).toEqual([]);
});
