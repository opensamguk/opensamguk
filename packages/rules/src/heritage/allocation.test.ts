import { expect, it } from 'vitest';
import { readHeritageAllocation } from './allocation';

const rules = { max: 80 },
  base = { leadership: 70, strength: 70, intel: 60 };
it('AC-P2-33 미선택은 비용 0이고 배분은 능력별 3·합계 6 이내다', () => {
  expect(readHeritageAllocation(undefined, rules, base)).toEqual({ ok: true, bonus: {}, cost: 0 });
  const input = { strength: 3, leadership: 3 },
    before = structuredClone(input);
  expect(readHeritageAllocation(input, rules, base)).toEqual({
    ok: true,
    bonus: { leadership: 3, strength: 3 },
    cost: 6,
  });
  expect(input).toEqual(before);
});
it.each([
  {},
  null,
  [],
  { leadership: 4 },
  { leadership: 0 },
  { leadership: -1 },
  { leadership: 1.5 },
  { leadership: '1' },
  { leadership: 3, strength: 3, intel: 1 },
  { politics: 1 },
  { unknown: 1 },
])('AC-P2-33 잘못된 배분을 거부한다: %j', (input) =>
  expect(readHeritageAllocation(input, rules, base)).toMatchObject({ ok: false, code: 'BAD_HERITAGE' }),
);
it('AC-P2-33 최종 생성 상한을 지키고 5능력치에만 정치·매력을 배분한다', () => {
  expect(readHeritageAllocation({ leadership: 3 }, rules, { ...base, leadership: 77 })).toMatchObject({
    ok: true,
    cost: 3,
  });
  expect(readHeritageAllocation({ leadership: 3 }, rules, { ...base, leadership: 78 })).toMatchObject({ ok: false });
  expect(
    readHeritageAllocation({ politics: 3, charm: 3 }, { count: 5, max: 90 }, { ...base, politics: 50, charm: 50 }),
  ).toMatchObject({ ok: true, cost: 6, bonus: { politics: 3, charm: 3 } });
});
