import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { applyEffects } from '../commands/effects';
import { runPolicyCommand } from './execute';

it('AC-M2-17 권농은 실제 명령 효과를 내고 같은 시드로 재현한다', () => {
  const state = commandWorld();
  state.generals[1]!.userId = 'human';
  const actor = { generalId: 1, tick: 1 };
  const result = runPolicyCommand(state, actor, 'farm', 'policy');
  expect(result).toEqual(runPolicyCommand(state, actor, 'farm', 'policy'));
  expect(result.commandKey).toBe('farm');
  const next = applyEffects(state, result.result.effects);
  expect(next.cities[1]!.agriculture).toBeGreaterThan(state.cities[1]!.agriculture);
  expect(next.generals[1]!.gold).toBeLessThan(state.generals[1]!.gold);
  expect(next.generals[1]!.userId).toBe('human');
  expect(result.result.logs[0]!.text).toBe('기본 방침(권농)으로 농지 개간');
});

it.each(['maximum', 'gold', 'supply'] as const)(
  'AC-M2-17 방침 실패 %s는 비용 없이 실제 휴식하고 이유를 남긴다',
  (failure) => {
    const state = commandWorld();
    const general = state.generals[1]!;
    general.userId = 'human';
    general.injury = 50;
    if (failure === 'maximum') state.cities[1]!.agriculture = state.cities[1]!.agricultureMax;
    if (failure === 'gold') general.gold = 0;
    if (failure === 'supply') state.cities[1]!.supplied = false;
    const result = runPolicyCommand(state, { generalId: 1 }, 'farm', 'policy');
    expect(result.commandKey).toBe('rest');
    expect(result.result.logs[0]!.text).toContain({ maximum: 'AT_MAX', gold: 'NO_GOLD', supply: 'NO_SUPPLY' }[failure]);
    const next = applyEffects(state, result.result.effects);
    expect(next.generals[1]!.injury).toBeLessThan(general.injury);
    expect(next.generals[1]!.gold).toBe(general.gold);
    expect(next.cities).toEqual(state.cities);
  },
);
