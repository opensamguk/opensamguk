// 리뷰 탐침(T1-07, t_f69c5c57). PR에 넣지 않는 별도 브랜치 전용 시험이다.
import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { hashState } from '@opensamguk/shared/node';
import {
  buildYearbook,
  initialReplayState,
  runMonthly,
  runReplayAction,
  settleDiplomacy,
  settleIncome,
  settlePopulation,
  settleSupply,
  toWorldState,
  type WorldState,
  type WorldView,
} from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';

const permutations = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

describe('리뷰 탐침 AC-M1-12 단계 순서', () => {
  it('세입이 인구·보급보다 늦은 순열은 모두 runMonthly와 다르다', async () => {
    const initial = await monthlyFixture();
    const before = toWorldState(initial);
    const date = { year: initial.startYear, month: 1 };
    const expected = runMonthly(before, 10000, rngFor(initial.seed, 'monthly', date.year, date.month));
    const stages: Record<string, (state: WorldView) => WorldState> = {
      income: (state) => settleIncome(state, date),
      population: (state) => settlePopulation(state),
      supply: (state) => settleSupply(state),
      diplomacy: (state) => settleDiplomacy(state, 10000),
    };
    const matching = permutations(Object.keys(stages))
      .filter((order) => {
        let state = structuredClone(before) as WorldState;
        for (const key of order) state = stages[key]!(state);
        state.generals[3]!.nextTurnTick = expected.state.generals[3]!.nextTurnTick;
        return (
          hashState(state) === hashState(expected.state) &&
          hashState(buildYearbook(state, date.year)) === hashState(expected.yearbook)
        );
      })
      .map((order) => order.join('>'));
    // 인구·보급·외교는 서로 다른 값을 바꿔 순서를 관측할 수 없다. 세입이 인구·보급보다 앞서야 한다.
    expect(matching).toContain('income>population>supply>diplomacy');
    const incomeFirst = (order: string) => {
      const keys = order.split('>');
      return keys.indexOf('income') < keys.indexOf('population') && keys.indexOf('income') < keys.indexOf('supply');
    };
    expect(matching.filter((order) => !incomeFirst(order))).toEqual([]);
    expect(matching).toHaveLength(8);
  });

  it('보급 단절은 다음 달 세입을 줄인다(단계 간 실제 상호작용)', async () => {
    const initial = await monthlyFixture();
    let state: WorldState = toWorldState(initial);
    for (let month = 1; month <= 7; month++) {
      state = runMonthly(state, month * 10000, rngFor(initial.seed, 'monthly', initial.startYear, month)).state;
    }
    // 7월 세입은 6개월 단절로 줄어든 도시 3 상업을 쓴다.
    expect(state.cities[3]!.commerce).toBeLessThan(100);
    expect(state.cities[3]!.supplied).toBe(false);
    expect(state.cities[1]!.supplied).toBe(true);
  });
});

describe('리뷰 탐침 AC-M1-13 메모리 재생 결정성', () => {
  const run = async (seed: string, commandKey: string) => {
    const initial = await monthlyFixture();
    initial.seed = seed;
    let replay = initialReplayState(initial);
    // 장수 2는 수도 도시에 있어 매달 보급이 이어진다.
    for (const id of [1, 2]) replay.turns[id] = Array.from({ length: 30 }, () => ({ commandKey, args: {} }));
    const hashes: string[] = [];
    while (replay.monthlyTick < 120000) {
      const before = replay.monthlyTick;
      replay = runReplayAction(replay, seed);
      if (replay.monthlyTick !== before) hashes.push(hashState(replay));
    }
    return hashes;
  };

  it('같은 시드는 12개월 해시가 같고 다른 시드는 난수를 쓰는 명령에서 달라진다', async () => {
    const first = await run('probe-a', 'farm');
    expect(first).toHaveLength(12);
    expect(await run('probe-a', 'farm')).toEqual(first);
    const other = await run('probe-b', 'farm');
    expect(other).toHaveLength(12);
    expect(other).not.toEqual(first);
  });
});
