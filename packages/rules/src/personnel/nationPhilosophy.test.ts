import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { BALANCE } from '../balance';
import { runGeneralTurn } from '../commands/turn';
import { settleIncome, settlePopulation } from '../monthly';
import { NATION_PHILOSOPHY_FEATURE, nationPhilosophyEffects } from './nationPhilosophy';

describe('국가 성향', () => {
  it('건국에 선택한 성향을 저장하고 옛 월드에서는 성향 인자를 거절한다', () => {
    const state = commandWorld();
    state.generals[4]!.gold = BALANCE.FOUND_COST;
    state.generals[4]!.userId = 'founder';
    const actor = { generalId: 4, tick: 0 };
    const choice = { commandKey: 'found', args: { name: '새 나라', color: '#3a5678', philosophy: '법가' } };
    const disabled = runGeneralTurn(state, actor, choice, 'philosophy', {});
    expect(disabled.result).toMatchObject({ code: 'BAD_ARGS' });
    state.ruleFeatures = [NATION_PHILOSOPHY_FEATURE];
    const enabled = runGeneralTurn(state, actor, choice, 'philosophy', {});
    const nationId = enabled.state.generals[4]!.nationId!;
    expect(enabled.state.nations[nationId]).toMatchObject({ name: '새 나라', philosophy: '법가' });
    expect(Object.keys(nationPhilosophyEffects())).toHaveLength(13);
    expect(nationPhilosophyEffects()['법가']).toMatchObject({
      benefits: expect.arrayContaining(['치안', '금수입']),
      drawbacks: expect.arrayContaining(['인구 증가', '민심']),
    });
  });

  it('법가의 치안 비용을 낮추고 금수입은 높이며 인구 증가량은 낮춘다', () => {
    const base = commandWorld();
    base.nations[1]!.philosophy = 'che_법가';
    base.generals[1]!.userId = 'investor';
    base.cities[1]!.security = 1;
    base.cities[1]!.population = Math.floor(base.cities[1]!.populationMax / 2);
    const state = structuredClone(base);
    state.ruleFeatures = [NATION_PHILOSOPHY_FEATURE];
    const actor = { generalId: 1, tick: 0 };
    const turn = { commandKey: 'security', args: {} };
    const before = runGeneralTurn(base, actor, turn, 'philosophy', {}).state;
    const after = runGeneralTurn(state, actor, turn, 'philosophy', {}).state;
    expect(after.generals[1]!.gold - before.generals[1]!.gold).toBe(
      BALANCE.DEVEL_COST - Math.round(BALANCE.DEVEL_COST * 0.8),
    );
    expect(after.cities[1]!.security).toBeGreaterThan(before.cities[1]!.security);
    const date = { year: state.startYear, month: 1 };
    expect(settleIncome(state, date).nations[1]!.gold).toBeGreaterThan(settleIncome(base, date).nations[1]!.gold);
    expect(settlePopulation(state).cities[1]!.population).toBeLessThan(settlePopulation(base).cities[1]!.population);
  });
});
