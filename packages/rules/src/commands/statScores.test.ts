import { createRng } from '@opensamguk/shared';
import { describe, expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { applyEffects } from './effects';
import { DOMESTIC_SPECS, makeInvestment } from './domestic/investment';
import { commandRegistry } from './registry';
import { domesticStatScore, drillGain, recruitCost } from './statScores';

function world() {
  const state = commandWorld();
  state.ruleFeatures = ['five-stats'];
  Object.assign(state.generals[1]!, { politics: 50, charm: 50 });
  return state;
}

describe('AC-INT-15 새 판의 명령 능력치', () => {
  it.each([0, 50, 100])('8종 내정의 점수 %i는 기존 비용·민심·전방·RNG 소비를 보존한다', (value) => {
    for (const spec of DOMESTIC_SPECS) {
      const next = world();
      Object.assign(next.generals[1]!, {
        leadership: value,
        strength: value,
        intel: value,
        politics: value,
        charm: value,
      });
      const legacy = commandWorld();
      legacy.generals[1]![spec.stat] = value;
      const rng = createRng('int15-domestic');
      const control = createRng('int15-domestic');
      const command = makeInvestment(spec);
      expect(command.execute(next, { generalId: 1 }, {}, rng)).toEqual(
        command.execute(legacy, { generalId: 1 }, {}, control),
      );
      expect(rng.next()).toBe(control.next());
    }
  });

  it('서로 다른 5값에서 정본 가중합과 정치·지력·매력 역할을 구분한다', () => {
    const state = world();
    const general = state.generals[1]!;
    Object.assign(general, { leadership: 80, strength: 10, intel: 30, politics: 90, charm: 20 });
    const expected = {
      farm: 90,
      commerce: 90,
      wall: 90,
      research: 30,
      goodwill: 20,
      settle: 62,
      defence: 83,
      security: 34,
    };
    for (const spec of DOMESTIC_SPECS)
      expect(domesticStatScore(state, general, spec.key, spec.stat)).toBe(expected[spec.key as keyof typeof expected]);
    Reflect.deleteProperty(general, 'politics');
    expect(() => domesticStatScore(state, general, 'farm', 'intel')).toThrow();
  });

  it.each([
    [0, 125],
    [50, 100],
    [100, 75],
  ])('매력 %i의 모병 비용은 %i이고 검사와 차감이 일치한다', (charm, cost) => {
    const state = world();
    const general = state.generals[1]!;
    Object.assign(general, { leadership: 100, charm, crew: 0, gold: cost });
    const unit = testUnits.crewTypes.find((row) => row.armType > 0)!;
    const units = {
      ...testUnits,
      crewTypes: testUnits.crewTypes.map((row) => (row.id === unit.id ? { ...row, cost: 1 } : row)),
    };
    const actor = { generalId: 1, unitSet: units };
    const args = { amount: 100, crewType: unit.id };
    const command = commandRegistry.get('recruit')!;
    expect(recruitCost(state, general, 100, 1, false)).toBe(cost);
    expect(command.check(state, actor, args)).toBeNull();
    const after = applyEffects(state, command.execute(state, actor, args, createRng('int15')).effects);
    expect(after.generals[1]!.gold).toBe(0);
    expect(after.generals[1]!.crew).toBe(100);
    expect(after.cities[1]!.population).toBe(state.cities[1]!.population - 100);
    general.gold--;
    expect(command.check(state, actor, args)).toMatchObject({ code: 'NO_GOLD' });
  });

  it('매력 할인은 징병 비용·민심 손실에 중첩하지 않는다', () => {
    const command = commandRegistry.get('conscript')!;
    const results = [0, 50, 100].map((charm) => {
      const state = world();
      Object.assign(state.generals[1]!, { leadership: 100, charm, crew: 0 });
      const unit = testUnits.crewTypes.find((row) => row.armType > 0)!;
      const result = command.execute(
        state,
        { generalId: 1, unitSet: testUnits },
        { amount: 100, crewType: unit.id },
        createRng('int15'),
      );
      const after = applyEffects(state, result.effects);
      return [state.generals[1]!.gold - after.generals[1]!.gold, state.cities[1]!.trust - after.cities[1]!.trust];
    });
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(results[0]![1]).toBeGreaterThan(0);
  });

  it.each([
    [0, 8],
    [50, 10],
    [100, 12],
  ])('훈련과 사기 점수 %i의 상승은 %i이며 최종100을 넘지 않는다', (value, gain) => {
    const state = world();
    Object.assign(state.generals[1]!, { leadership: value, charm: value, crew: 100, train: 99, atmos: 99 });
    for (const [key, morale] of [
      ['train', false],
      ['morale', true],
    ] as const) {
      expect(drillGain(state, state.generals[1]!, morale)).toBe(gain);
      const after = applyEffects(
        state,
        commandRegistry.get(key)!.execute(state, { generalId: 1 }, {}, createRng('int15')).effects,
      );
      expect(after.generals[1]![morale ? 'atmos' : 'train']).toBe(100);
    }
  });
});
