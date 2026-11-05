import { createRng } from '@opensamguk/shared';
import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { cloneWorld } from '../model/clone';
import type { WorldState } from '../model/world';
import { initialLogisticsState } from '../logistics/state';
import { STANDARD_EQUIPMENT_CONFIG } from './catalog';
import type { EquipmentSlot } from './config';
import { initialEquipment } from './state';
import { equipmentBonus } from './stats';
import { TEST_EQUIPMENT_LOGISTICS_CONFIG } from './testFixture';
import { equipmentTrade } from './trade';

const actor = { generalId: 1 };
function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['equipment-v1', 'logistics-v1'];
  world.equipment = initialEquipment(STANDARD_EQUIPMENT_CONFIG);
  world.logistics = initialLogisticsState(TEST_EQUIPMENT_LOGISTICS_CONFIG, world);
  Object.assign(world.logistics.cities['1']!, { iron: 100, wood: 100, horses: 100 });
  world.cities[1]!.security = 10000;
  return world;
}
function trade(world: WorldState, slot: EquipmentSlot, itemKey: string) {
  const args = { slot, itemKey };
  expect(equipmentTrade.check(world, actor, args)).toBeNull();
  const result = equipmentTrade.execute(world, actor, args, createRng('approved-equipment'));
  expect(result.effects).toHaveLength(1);
  const effect = result.effects[0]!;
  if (effect.kind !== 'world') throw new Error('전체 월드 효과가 아닙니다.');
  return effect.state;
}

it('AC-P2-12 승인한 일반 장비만 세 칸·여섯 등급으로 제공한다', () => {
  expect(STANDARD_EQUIPMENT_CONFIG.items).toHaveLength(18);
  expect(STANDARD_EQUIPMENT_CONFIG.sellRateBp).toBe(5000);
  expect(STANDARD_EQUIPMENT_CONFIG.tradeExperience).toBe(10);
  expect(STANDARD_EQUIPMENT_CONFIG.items.map(({ name }) => name)).toEqual([
    '노기',
    '조랑',
    '노새',
    '나귀',
    '갈색마',
    '흑색마',
    '단도',
    '단궁',
    '단극',
    '목검',
    '죽창',
    '소부',
    '효경전',
    '회남자',
    '변도론',
    '건상역주',
    '여씨춘추',
    '사민월령',
  ]);
});

it.each(STANDARD_EQUIPMENT_CONFIG.items)('AC-P2-12·30 $key 구매·판매의 금·경험·실물 재고를 보존한다', (item) => {
  const world = fixture();
  const cost = [1000, 3000, 6000, 10000, 15000, 21000][item.grade - 1]!;
  const city = world.cities[1]!;
  city.security = item.grade * 1000 - 1;
  expect(equipmentTrade.check(world, actor, { slot: item.slot, itemKey: item.key })?.code).toBe('BAD_STATE');
  city.security = item.grade * 1000;
  const before = cloneWorld(world);
  const next = trade(world, item.slot, item.key);
  expect(next.generals[1]).toEqual({ ...world.generals[1], gold: 100000 - cost, experience: 10 });
  expect(next.equipment!.generals['1']).toEqual({ [item.slot]: item.key });
  expect(equipmentBonus(next, 1)).toEqual({
    leadership: item.slot === 'horse' ? item.grade : 0,
    strength: item.slot === 'weapon' ? item.grade : 0,
    intel: item.slot === 'book' ? item.grade : 0,
  });
  expect(next.logistics!.cities['1']).toEqual({
    ...world.logistics!.cities['1'],
    iron: 100 - (item.slot === 'weapon' ? item.grade * 5 : 0),
    horses: 100 - (item.slot === 'horse' ? item.grade * 5 : 0),
  });
  const sold = trade(next, item.slot, 'none');
  expect(sold.generals[1]).toEqual({ ...world.generals[1], gold: 100000 - cost / 2, experience: 20 });
  expect(sold.logistics).toEqual(next.logistics);
  expect(sold.equipment!.generals).toEqual({});
  expect(world).toEqual(before);
});

it('AC-P2-12 승인 카탈로그의 교체는 기존 장비 가격을 환급하지 않는다', () => {
  const world = fixture();
  const first = trade(world, 'horse', 'horse_01');
  const replaced = trade(first, 'horse', 'horse_06');
  expect(replaced.generals[1]!.gold).toBe(78000);
  expect(replaced.logistics!.cities['1']!.horses).toBe(65);
  expect(replaced.equipment!.generals['1']).toEqual({ horse: 'horse_06' });
});
