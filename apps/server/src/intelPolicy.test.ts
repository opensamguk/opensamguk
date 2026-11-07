import { expect, it } from 'vitest';
import { intelPolicy } from './intelPolicy';

it('AC-P2-07 승인된 병력 구간의 양쪽 경계와 열린 상한을 보존한다', () => {
  for (const [min, max] of [
    [0, 0],
    [1, 999],
    [1_000, 4_999],
    [5_000, 9_999],
    [10_000, 19_999],
    [20_000, 49_999],
    [50_000, null],
  ] as const) {
    expect(intelPolicy.crew(min)).toEqual({ min, max });
    expect(intelPolicy.crew(max ?? Number.MAX_SAFE_INTEGER)).toEqual({ min, max });
  }
  expect(intelPolicy.withinAge(600)).toBe(true);
});
