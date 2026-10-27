import { describe, expect, it } from 'vitest';
import { commandInitial, commandWorld } from '../../../../test/commandFixture';
import { createRng, type Rng } from '@opensamguk/shared';
import { resolverForRuleFeatures } from '../../../ruleCommands';
import { checkReplayOrigin, checkRuleFeatures } from '../../../ruleRegistry';
import { stratagemAttackScore, stratagemProbability } from './base';
import { stratagemCommands } from './index';

function world() {
  const state = commandWorld();
  state.ruleFeatures = ['five-stats', 'stratagem-basic'];
  for (const general of Object.values(state.generals)) Object.assign(general, { politics: 50, charm: 50 });
  Object.assign(state.generals[1]!, { intel: 60, strength: 80, charm: 20 });
  for (const general of Object.values(state.generals)) if (general.id !== 1) general.cityKey = 3;
  Object.assign(state.cities[2]!, { security: 0, supplied: false });
  return state;
}

function trackingRng(failure: boolean) {
  const calls: string[] = [];
  const source = createRng('int17-unchanged-damage-stream');
  const rng: Rng = {
    next() {
      calls.push('next');
      return failure ? 0.999 : 0;
    },
    int(min, max) {
      calls.push(`int:${min}:${max}`);
      return source.int(min, max);
    },
    pick() {
      throw new Error('계략은 pick을 사용하지 않습니다.');
    },
  };
  return { rng, calls };
}

describe('AC-INT-17 기본 계략의 5능력치 어댑터', () => {
  it('화계·파괴는 지력, 선동은 매력70/지력30, 탈취는 무력70/지력30을 사용한다', () => {
    const general = world().generals[1]!;
    expect(stratagemAttackScore(general, 'fire_attack')).toBe(60);
    expect(stratagemAttackScore(general, 'sabotage')).toBe(60);
    expect(stratagemAttackScore(general, 'incite')).toBe(32);
    expect(stratagemAttackScore(general, 'plunder')).toBe(74);
    general.charm = 21;
    expect(stratagemAttackScore(general, 'incite')).toBe(33);
    delete general.charm;
    expect(() => stratagemAttackScore(general, 'fire_attack')).toThrow();
  });

  it('방어 장수가 있으면 공격 계열과 관계없이 지력으로 저항한다', () => {
    const state = world();
    const defender = state.generals[2]!;
    Object.assign(defender, { cityKey: 2, nationId: state.cities[2]!.nationId, intel: 50, strength: 1, leadership: 1 });
    const before = stratagemProbability(state, { generalId: 1 }, 2, 'strength', 'plunder');
    expect(before).toBeCloseTo(0.35 + 74 / 300 - (50 / 300 - 0.01));
    defender.strength = 100;
    defender.leadership = 100;
    expect(stratagemProbability(state, { generalId: 1 }, 2, 'strength', 'plunder')).toBe(before);
    defender.intel = 80;
    expect(stratagemProbability(state, { generalId: 1 }, 2, 'strength', 'plunder')).toBeCloseTo(before - 0.1);
  });

  it('방어 장수가 없으면 기존 도시 보안·보급 경로를 유지한다', () => {
    const state = world();
    state.cities[2]!.security = state.cities[2]!.securityMax;
    state.cities[2]!.supplied = true;
    expect(stratagemProbability(state, { generalId: 1 }, 2, 'intel', 'fire_attack')).toBeCloseTo(
      0.35 + 60 / 300 - (-0.05 + 0.2 + 0.1),
    );
  });

  it('실제 파괴 명령은 기존 strength spec과 관계없이 지력80의 성공 경계를 쓴다', () => {
    const state = world();
    Object.assign(state.generals[1]!, { intel: 80, strength: 70 });
    Object.assign(state.generals[2]!, { cityKey: 2, nationId: state.cities[2]!.nationId, intel: 50 });
    const sabotage = stratagemCommands.find((command) => command.key === 'sabotage')!;
    const execute = () =>
      sabotage.execute(
        state,
        { generalId: 1 },
        { cityKey: 2 },
        { ...createRng('sabotage-boundary'), next: () => 0.44 },
      );
    expect(execute().logs[0]!.text).toContain('파괴 성공');
    state.generals[1]!.intel = 70;
    state.generals[1]!.strength = 100;
    expect(execute().logs[0]!.text).toContain('파괴 실패');
  });

  it.each(stratagemCommands)('$key의 비용·피해·성공/실패 난수 순서는 기존 규칙과 같다', (command) => {
    for (const failure of [false, true]) {
      const modern = world();
      const legacy = structuredClone(modern);
      delete legacy.ruleFeatures;
      const modernRng = trackingRng(failure),
        legacyRng = trackingRng(failure);
      const actor = { generalId: 1 },
        args = { cityKey: 2 };
      const before = structuredClone(modern);
      const result = command.execute(modern, actor, args, modernRng.rng);
      expect(result).toEqual(command.execute(legacy, actor, args, legacyRng.rng));
      expect(modernRng.calls).toEqual(legacyRng.calls);
      expect(
        result.effects.filter(
          (effect) => effect.kind === 'general' && effect.id === 1 && ['gold', 'rice'].includes(effect.field),
        ),
      ).toEqual(
        expect.arrayContaining([
          { kind: 'general', id: 1, field: 'gold', op: 'add', value: -100 },
          { kind: 'general', id: 1, field: 'rice', op: 'add', value: -100 },
        ]),
      );
      expect(modern).toEqual(before);
    }
  });

  it('인사·정책·조약과 함께 등록하고 네 명령만 추가한다', () => {
    const state = world();
    state.ruleFeatures = ['five-stats', 'personnel', 'policy', 'stratagem-basic', 'treaty'];
    expect(checkRuleFeatures(state.ruleFeatures)).toEqual(state.ruleFeatures);
    const resolver = resolverForRuleFeatures(state)!;
    for (const command of stratagemCommands) expect(resolver.get(command.key)).toBe(command);
    expect(resolver.get('scout')).toBeUndefined();
    expect(() => checkRuleFeatures(['stratagem-basic'])).toThrow();
    const initial = commandInitial();
    initial.statRules = { count: 5, total: 275, min: 15, max: 90 };
    initial.ruleFeatures = state.ruleFeatures;
    for (const general of initial.generals) Object.assign(general, { politics: 50, charm: 50 });
    const origin = {
      version: 3,
      initial,
      initialStateHash: 'checked-by-transport',
      resourceHash: 'checked-by-transport',
      featureData: { policy: { version: 1, turnTermMinutes: 60 } },
    };
    expect(() => checkReplayOrigin(origin)).not.toThrow();
    expect(() =>
      checkReplayOrigin({ ...origin, featureData: { ...origin.featureData, 'stratagem-basic': {} } }),
    ).toThrow();
  });
});
