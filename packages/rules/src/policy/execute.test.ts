import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { applyEffects } from '../commands/effects';
import { resolverForRuleFeatures } from '../ruleCommands';
import { runPolicyCommand, runPolicySlot } from './execute';
import { normalizeSlot } from './index';

it.each([
  ['farm', 'farm'],
  ['commerce', 'commerce'],
  ['security', 'security'],
  ['defend', 'defence'],
  ['drill', 'train'],
  ['none', 'rest'],
] as const)('AC-M2-17 방침 %s는 실제 %s 명령을 실행한다', (policy, commandKey) => {
  const state = commandWorld();
  Object.assign(state.logistics!.cities['1']!, { iron: 3000, wood: 3000, horses: 3000 });
  state.generals[1]!.userId = 'human';
  state.generals[1]!.train = 0;
  state.campaign!.units[0]!.train = 0;
  const result = runPolicyCommand(state, { generalId: 1 }, policy, 'policy', resolverForRuleFeatures(state));
  expect(result.commandKey).toBe(commandKey);
  expect(result.result.effects.length).toBeGreaterThan(0);
  expect(result.result.logs.some((log) => log.text.includes('실패'))).toBe(false);
});

it.each(['defend', 'drill'] as const)('AC-M2-17 방침 %s의 두 명령이 모두 최대이면 휴식한다', (policy) => {
  const state = commandWorld();
  Object.assign(state.logistics!.cities['1']!, { iron: 3000, wood: 3000, horses: 3000 });
  state.generals[1]!.userId = 'human';
  state.generals[1]!.train = 100;
  state.generals[1]!.atmos = 100;
  state.cities[1]!.defence = state.cities[1]!.defenceMax;
  state.cities[1]!.wall = state.cities[1]!.wallMax;
  const result = runPolicyCommand(state, { generalId: 1 }, policy, 'policy', resolverForRuleFeatures(state));
  expect(result.commandKey).toBe('rest');
  expect(result.result.logs[0]!.text).toBe('기본 방침 실패: 이미 최대치입니다. → 휴식');
});

it('AC-M2-17 직접 명령·직접 휴식·옛 휴식은 미접속이어도 방침으로 덮지 않는다', () => {
  const state = commandWorld();
  Object.assign(state.logistics!.cities['1']!, { iron: 3000, wood: 3000, horses: 3000 });
  state.generals[1]!.userId = 'human';
  const actor = { generalId: 1, tick: 10_000_000 };
  for (const commandKey of ['rest', 'move', 'attack']) {
    const slot = normalizeSlot({ commandKey, args: commandKey === 'rest' ? {} : { cityKey: 2 } });
    expect(runPolicySlot(state, actor, slot, 'farm', 'policy')).toBeNull();
  }
  const legacy = { commandKey: 'rest', args: {} } as Parameters<typeof runPolicySlot>[2];
  expect(runPolicySlot(state, actor, legacy, 'farm', 'policy')).toBeNull();
  const empty = { commandKey: 'rest', args: {}, explicit: false };
  expect(runPolicySlot(state, actor, empty, 'farm', 'policy')?.commandKey).toBe('farm');
  expect(runPolicySlot(state, actor, empty, 'none', 'policy')?.commandKey).toBe('rest');
  expect(runPolicySlot(state, { ...actor, generalId: 2 }, empty, 'farm', 'policy')).toBeNull();
});

it.each([
  ['defend', 'wall'],
  ['drill', 'morale'],
] as const)('AC-M2-17 방침 %s는 최대치 뒤 %s의 실제 효과를 낸다', (policy, commandKey) => {
  const state = commandWorld();
  Object.assign(state.logistics!.cities['1']!, { iron: 3000, wood: 3000, horses: 3000 });
  state.generals[1]!.userId = 'human';
  state.generals[1]!.train = 100;
  state.generals[1]!.atmos = 0;
  state.campaign!.units[0]!.atmos = 0;
  state.cities[1]!.defence = state.cities[1]!.defenceMax;
  state.cities[1]!.wall = 0;
  const result = runPolicyCommand(state, { generalId: 1 }, policy, 'policy', resolverForRuleFeatures(state));
  expect(result.commandKey).toBe(commandKey);
  const next = applyEffects(state, result.result.effects);
  if (policy === 'defend') expect(next.cities[1]!.wall).toBeGreaterThan(0);
  else {
    expect(next.campaign!.units[0]!.atmos).toBeGreaterThan(0);
    expect(next.generals[1]!.atmos).toBe(0);
    expect(next.generals[1]!.crew).toBe(0);
  }
});

it('AC-M2-17 훈련 방침은 부곡이 없으면 비용 없이 휴식하고 실패 사유를 남긴다', () => {
  const state = commandWorld();
  state.generals[1]!.userId = 'human';
  state.campaign!.units = state.campaign!.units.filter((unit) => unit.ownerId !== 1);
  const result = runPolicyCommand(state, { generalId: 1 }, 'drill', 'policy', resolverForRuleFeatures(state));
  expect(result.commandKey).toBe('rest');
  expect(result.result.logs[0]!.text).toBe('기본 방침 실패: 병력이 없습니다. → 휴식');
  const next = applyEffects(state, result.result.effects);
  expect(next.generals[1]!.gold).toBe(state.generals[1]!.gold);
  expect(next.generals[1]!.injury).toBeLessThan(state.generals[1]!.injury);
  expect(next.campaign).toEqual(state.campaign);
});

it('AC-M2-17 훈련 방침은 선택한 부곡만 훈련하고 개인 병력을 만들지 않는다', () => {
  const state = commandWorld();
  state.generals[1]!.userId = 'human';
  const unit = state.campaign!.units[0]!;
  unit.train = 0;
  unit.troops = 100;
  state.campaign!.units.push({ ...unit, id: 4, train: 50 });
  state.campaign!.nextUnitId = 5;
  state.campaign!.units.reverse();
  const result = runPolicyCommand(state, { generalId: 1 }, 'drill', 'policy', resolverForRuleFeatures(state));
  expect(result.commandKey).toBe('train');
  const next = applyEffects(state, result.result.effects);
  expect(next.campaign!.units.find((unit) => unit.id === 1)!.train).toBeGreaterThan(0);
  expect(next.campaign!.units.find((unit) => unit.id === 4)!.train).toBe(50);
  expect(next.generals[1]!.train).toBe(state.generals[1]!.train);
  expect(next.generals[1]!.crew).toBe(0);
});

it('AC-M2-17 권농은 실제 명령 효과를 내고 같은 시드로 재현한다', () => {
  const state = commandWorld();
  Object.assign(state.logistics!.cities['1']!, { iron: 3000, wood: 3000, horses: 3000 });
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
    Object.assign(state.logistics!.cities['1']!, { iron: 3000, wood: 3000, horses: 3000 });
    const general = state.generals[1]!;
    general.userId = 'human';
    general.injury = 50;
    if (failure === 'maximum') state.cities[1]!.agriculture = state.cities[1]!.agricultureMax;
    if (failure === 'gold') general.gold = 0;
    if (failure === 'supply') state.cities[1]!.supplied = false;
    const result = runPolicyCommand(state, { generalId: 1 }, 'farm', 'policy');
    expect(result.commandKey).toBe('rest');
    expect(result.result.logs[0]!.text).toBe(
      `기본 방침 실패: ${{ maximum: '이미 최대치입니다.', gold: '금이 부족합니다.', supply: '보급이 끊긴 도시입니다.' }[failure]} → 휴식`,
    );
    const next = applyEffects(state, result.result.effects);
    expect(next.generals[1]!.injury).toBeLessThan(general.injury);
    expect(next.generals[1]!.gold).toBe(general.gold);
    expect(next.cities).toEqual(state.cities);
  },
);
