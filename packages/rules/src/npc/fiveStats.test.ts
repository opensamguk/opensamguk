import { createRng } from '@opensamguk/shared';
import { expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { commandRegistry } from '../commands/registry';
import { affordableRecruits, recruitCost } from '../commands/statScores';
import { chooseGeneralTurn } from './index';

const context = { tick: 100, unitSet: testUnits };
function world(stats: { leadership: number; strength: number; intel: number; politics: number; charm: number }) {
  const state = commandWorld();
  state.ruleFeatures = ['five-stats'];
  Object.assign(state.generals[1]!, stats, { crew: 2000, train: 100, atmos: 100, rice: 100000 });
  state.cities[1]!.agriculture = 0;
  return state;
}

it('같은 전선·시드에서 내정가는 정치 내정을, 무장은 출병을 고른다', () => {
  const civil = world({ leadership: 35, strength: 25, intel: 60, politics: 90, charm: 65 });
  const military = world({ leadership: 65, strength: 90, intel: 45, politics: 30, charm: 45 });
  for (const state of [civil, military]) {
    const first = chooseGeneralTurn(state, state.generals[1]!, createRng('int15-role'), context);
    expect(first).toEqual(chooseGeneralTurn(state, state.generals[1]!, createRng('int15-role'), context));
    expect(
      first.candidates.every(
        (row) => commandRegistry.get(row.key)!.check(state, { generalId: 1, ...context }, row.args) === null,
      ),
    ).toBe(true);
  }
  expect(['farm', 'commerce', 'wall']).toContain(
    chooseGeneralTurn(civil, civil.generals[1]!, createRng('int15-role'), context).chosen?.key,
  );
  expect(chooseGeneralTurn(military, military.generals[1]!, createRng('int15-role'), context).chosen?.key).toBe(
    'attack',
  );
});

it('후방 인재 담당은 매력을 쓰는 주민 선정을 고른다', () => {
  const state = world({ leadership: 40, strength: 30, intel: 55, politics: 60, charm: 90 });
  state.cities[1]!.connections = [4];
  state.cities[4]!.connections = [1, 2];
  state.cities[4]!.supplied = true;
  state.cities[1]!.trust = 20;
  expect(chooseGeneralTurn(state, state.generals[1]!, createRng('int15-role'), context).chosen?.key).toBe('goodwill');
});

it.each([0, 50, 100])('매력 %i NPC의 모병량은 실제 차감 비용 안에서 최대이며 인구·통솔을 넘지 않는다', (charm) => {
  const state = world({ leadership: 100, strength: 50, intel: 50, politics: 50, charm });
  const general = state.generals[1]!;
  Object.assign(general, { crew: 0, gold: 1001 });
  state.cities[1]!.population = 1000;
  const decision = chooseGeneralTurn(state, general, createRng('int15-cost'), context);
  const candidate = decision.candidates.find((row) => row.key === 'recruit')!;
  expect(candidate).toBeDefined();
  const amount = candidate.args.amount as number;
  const cost = testUnits.crewTypes.find((row) => row.id === general.crewType)!.cost;
  expect(amount).toBe(affordableRecruits(state, general, cost, 1000));
  expect(recruitCost(state, general, amount, cost, false)).toBeLessThanOrEqual(general.gold);
  expect(recruitCost(state, general, amount + 1, cost, false)).toBeGreaterThan(general.gold);
  expect(amount).toBeLessThanOrEqual(Math.min(state.cities[1]!.population, general.leadership * 100));
});
