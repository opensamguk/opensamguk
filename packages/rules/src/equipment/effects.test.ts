import { createRng } from '@opensamguk/shared';
import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { commandFiveStats, domesticStatScore, drillGain } from '../commands/statScores';
import { stratagemAttackScore, stratagemProbability } from '../commands/ext/stratagem/base';
import { initialLogisticsState } from '../logistics/state';
import type { WorldState } from '../model/world';
import { STANDARD_EQUIPMENT_CONFIG } from './catalog';
import type { EquipmentSlot } from './config';
import { initialEquipment } from './state';
import { withEquipmentBonus } from './stats';
import { TEST_EQUIPMENT_LOGISTICS_CONFIG } from './testFixture';
import { equipmentTrade } from './trade';

function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats', 'equipment-v1', 'logistics-v1', 'stratagem-basic'];
  for (const general of Object.values(world.generals)) Object.assign(general, { politics: 100, charm: 100 });
  Object.assign(world.generals[1]!, { leadership: 100, strength: 100, intel: 100, gold: 100000 });
  world.equipment = initialEquipment(STANDARD_EQUIPMENT_CONFIG);
  world.logistics = initialLogisticsState(TEST_EQUIPMENT_LOGISTICS_CONFIG, world);
  Object.assign(world.logistics.cities['1']!, { iron: 100, wood: 100, horses: 100 });
  world.cities[1]!.security = 10000;
  return world;
}
function purchase(world: WorldState, slot: EquipmentSlot) {
  const actor = { generalId: 1 },
    args = { slot, itemKey: `${slot}_06` };
  expect(equipmentTrade.check(world, actor, args)).toBeNull();
  const result = equipmentTrade.execute(world, actor, args, createRng('equipment-effects'));
  const effect = result.effects[0]!;
  if (effect.kind !== 'world') throw new Error('전체 월드 효과가 아닙니다.');
  return effect.state;
}
function equipped() {
  return purchase(purchase(purchase(fixture(), 'horse'), 'weapon'), 'book');
}

it('AC-P2-12 D-070 실제 6등급 매매 뒤 계산값은 106이며 기본값·매매 재고는 따로 유지한다', () => {
  const world = equipped(),
    before = structuredClone(world),
    general = world.generals[1]!;
  const base = commandFiveStats(world, general)!;
  expect(base).toEqual({ leadership: 100, strength: 100, intel: 100, politics: 100, charm: 100 });
  expect(withEquipmentBonus(world, 1, base)).toEqual({ ...base, leadership: 106, strength: 106, intel: 106 });
  expect(domesticStatScore(world, general, 'research', 'intel')).toBe(106);
  expect(domesticStatScore(world, general, 'defence', 'leadership')).toBe(104);
  expect(domesticStatScore(world, general, 'security', 'strength')).toBe(104);
  expect(domesticStatScore(world, general, 'farm', 'intel')).toBe(100);
  expect(general.gold).toBe(37000);
  expect(world.logistics!.cities['1']).toMatchObject({ iron: 70, horses: 70 });
  expect(world).toEqual(before);
});

it('AC-P2-12 장비 통솔은 훈련·사기 경계에 반영하고 기본 능력치를 올리지 않는다', () => {
  const world = equipped(),
    general = world.generals[1]!;
  general.leadership = 99;
  expect(drillGain(world, general, false)).toBe(12);
  world.ruleFeatures = world.ruleFeatures!.filter((key) => key !== 'equipment-v1');
  expect(drillGain(world, general, false)).toBe(11);
  general.leadership = 60;
  general.charm = 0;
  expect(drillGain(world, general, true)).toBe(8);
  world.ruleFeatures.push('equipment-v1');
  expect(drillGain(world, general, true)).toBe(9);
  expect(general.leadership).toBe(60);
});

it('AC-P2-12 장비를 끈 계산은 장착 원장을 읽지 않고 같은 기본값을 반환한다', () => {
  const world = equipped(),
    general = world.generals[1]!;
  world.ruleFeatures = world.ruleFeatures!.filter((key) => key !== 'equipment-v1');
  Object.defineProperty(world, 'equipment', {
    get() {
      throw new Error('장착 원장을 읽었습니다.');
    },
  });
  const base = commandFiveStats(world, general)!;
  expect(withEquipmentBonus(world, 1, base)).toBe(base);
  expect(domesticStatScore(world, general, 'research', 'intel')).toBe(100);
  expect(stratagemAttackScore(general, 'fire_attack', world)).toBe(100);
});

it('AC-P2-12 서적·무기는 네 계략 점수에 반영하며 공격자·수비자의 지력에 같은 보너스를 쓴다', () => {
  const world = equipped(),
    general = world.generals[1]!;
  expect(stratagemAttackScore(general, 'fire_attack', world)).toBe(106);
  expect(stratagemAttackScore(general, 'sabotage', world)).toBe(106);
  expect(stratagemAttackScore(general, 'plunder', world)).toBe(106);
  expect(stratagemAttackScore(general, 'incite', world)).toBe(102);
  world.cities[2]!.security = 0;
  world.cities[2]!.supplied = false;
  for (const defender of Object.values(world.generals).filter((row) => row.cityKey === 2)) defender.intel = 100;
  const attack = stratagemProbability(world, { generalId: 1 }, 2, 'intel', 'fire_attack');
  for (const defender of Object.values(world.generals).filter((row) => row.cityKey === 2))
    world.equipment!.generals[String(defender.id)] = { book: 'book_06' };
  expect(stratagemProbability(world, { generalId: 1 }, 2, 'intel', 'fire_attack')).toBeCloseTo(attack - 6 / 300);
  expect(general.intel).toBe(100);
  general.intel = 101;
  expect(() => stratagemAttackScore(general, 'fire_attack', world)).toThrow();
});
