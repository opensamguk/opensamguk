import { createRng } from '@opensamguk/shared';
import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { cloneWorld } from '../model/clone';
import type { WorldState } from '../model/world';
import { deepFreeze } from '../personnel/testFixture';
import { LINEAGE_EXITED_YEAR } from '../lineage/config';
import { logisticsCommandMovements } from '../logistics/consumption';
import { initialLogisticsState, type LogisticsConfig } from '../logistics/state';
import { EQUIPMENT_MAX, type EquipmentSlot } from './config';
import { initialEquipment } from './state';
import { TEST_EQUIPMENT_CONFIG } from './testFixture';
import { equipmentTrade } from './trade';

const actor = { generalId: 1 };
const horse = { slot: 'horse' as const, itemKey: 'horse_01' };
const config: LogisticsConfig = {
  version: 1,
  specialties: [],
  capacity: { base: 1000, perLevel: 1000, maxLevel: 2 },
  upgrade: { gold: 1, wood: 1 },
  transport: { maxHops: 8, hopsPerMonth: 2, lossBpPerHop: 100, maxPerOrder: 100, maxActivePerNation: 2 },
  recruitPer100: { '1': { iron: 2, wood: 0, horses: 0 } },
  build: { wall: { iron: 0, wood: 4, horses: 0 }, defence: { iron: 2, wood: 3, horses: 0 } },
  trade: { iron: { buy: 3, sell: 1 }, wood: { buy: 3, sell: 1 }, horses: { buy: 3, sell: 1 } },
};
function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['equipment-v1', 'logistics-v1'];
  world.equipment = initialEquipment(TEST_EQUIPMENT_CONFIG);
  world.logistics = initialLogisticsState(config, world);
  Object.assign(world.logistics.cities['1']!, { iron: 20, wood: 20, horses: 20 });
  return world;
}
function trade(world: WorldState, args: { slot: EquipmentSlot; itemKey: string }) {
  const before = cloneWorld(world),
    rng = createRng('equipment-trade'),
    control = createRng('equipment-trade');
  expect(equipmentTrade.check(deepFreeze(world), actor, args)).toBeNull();
  const result = equipmentTrade.execute(world, actor, args, rng),
    effect = result.effects[0]!;
  expect(result.effects).toHaveLength(1);
  if (effect.kind !== 'world') throw new Error('전체 월드 효과가 아닙니다.');
  expect(rng.next()).toBe(control.next());
  expect(world).toEqual(before);
  return effect.state;
}

it.each([
  { slot: 'horse' as const, itemKey: 'horse_01', good: 'horses' as const, amount: 2, cost: 11 },
  { slot: 'weapon' as const, itemKey: 'weapon_01', good: 'iron' as const, amount: 3, cost: 13 },
  { slot: 'book' as const, itemKey: 'book_01', good: 'wood' as const, amount: 0, cost: 17 },
])('AC-P2-12·30 $slot 구매는 금·실물 재고만 소비하고 기본 능력치를 보존한다', (args) => {
  const world = fixture(),
    next = trade(world, { slot: args.slot, itemKey: args.itemKey });
  expect(next.equipment!.generals['1']).toEqual({ [args.slot]: args.itemKey });
  expect(next.generals[1]).toEqual({ ...world.generals[1], gold: 100000 - args.cost, experience: 2 });
  expect(next.logistics!.cities['1']![args.good]).toBe(20 - args.amount);
  expect(next.logistics!.revision).toBe(world.logistics!.revision + (args.amount ? 1 : 0));
  expect(logisticsCommandMovements(world, next)).toEqual(
    args.amount ? [{ holder: 'city', id: 1, good: args.good, delta: -args.amount, reason: 'CONSUME' }] : [],
  );
  expect(next.generals[2]).toEqual(world.generals[2]);
});

it('AC-P2-12 판매는 명시 비율을 내림하고 빈 장착 행과 재화 환급을 남기지 않는다', () => {
  const world = fixture();
  world.equipment!.generals['1'] = { horse: 'horse_01', book: 'book_01' };
  const next = trade(world, { slot: 'horse', itemKey: 'none' });
  expect(next.generals[1]!.gold).toBe(100004);
  expect(next.equipment!.generals['1']).toEqual({ book: 'book_01' });
  expect(next.logistics).toEqual(world.logistics);
  const empty = trade(next, { slot: 'book', itemKey: 'none' });
  expect(empty.generals[1]!.gold).toBe(100010);
  expect(empty.generals[1]!.experience).toBe(4);
  expect(empty.equipment!.generals).toEqual({});
  expect(logisticsCommandMovements(next, empty)).toEqual([]);
});

it('AC-P2-12 인공 제안 정책의 교체는 이전 장비 판매 금을 더하지 않는다', () => {
  const world = fixture();
  world.equipment!.generals['1'] = { horse: 'horse_01' };
  world.equipment!.config.items.push({
    ...world.equipment!.config.items[0]!,
    key: 'horse_02',
    name: '시험명마2',
    grade: 2,
    cost: 19,
    bonus: 2,
    goods: { iron: 0, wood: 0, horses: 3 },
  });
  const next = trade(world, { slot: 'horse', itemKey: 'horse_02' });
  expect(next.generals[1]!.gold).toBe(99981);
  expect(next.equipment!.generals['1']).toEqual({ horse: 'horse_02' });
  expect(next.logistics!.cities['1']!.horses).toBe(17);
});

it.each<[string, (world: WorldState) => void, string]>([
  [
    '끈 판',
    (w) => {
      w.ruleFeatures = ['logistics-v1'];
    },
    'COMMAND_DISABLED',
  ],
  [
    '물류 없는 판',
    (w) => {
      w.ruleFeatures = ['equipment-v1'];
      delete w.logistics;
    },
    'COMMAND_DISABLED',
  ],
  [
    '무소속',
    (w) => {
      w.generals[1]!.nationId = null;
    },
    'NOT_NATION',
  ],
  [
    '타국 도시',
    (w) => {
      w.cities[1]!.nationId = 2;
    },
    'NOT_OWN_CITY',
  ],
  [
    '보급 단절',
    (w) => {
      w.cities[1]!.supplied = false;
    },
    'NO_SUPPLY',
  ],
  [
    '치안 부족',
    (w) => {
      w.cities[1]!.security = 0;
    },
    'BAD_STATE',
  ],
  [
    '금 부족',
    (w) => {
      w.generals[1]!.gold = 0;
    },
    'NO_GOLD',
  ],
  [
    '말 부족',
    (w) => {
      w.logistics!.cities['1']!.horses = 1;
    },
    'NO_GOODS',
  ],
  [
    '같은 장비',
    (w) => {
      w.equipment!.generals['1'] = { horse: 'horse_01' };
    },
    'BAD_STATE',
  ],
  [
    '퇴장',
    (w) => {
      w.generals[1]!.activeFromYear = LINEAGE_EXITED_YEAR;
    },
    'BAD_STATE',
  ],
  [
    '경험 한도',
    (w) => {
      w.generals[1]!.experience = EQUIPMENT_MAX;
    },
    'BAD_STATE',
  ],
  [
    '재고 변경 한도',
    (w) => {
      w.logistics!.revision = EQUIPMENT_MAX;
    },
    'BAD_STATE',
  ],
])('AC-P2-12 %s 거부는 재화·장착·경험을 바꾸지 않는다', (_name, change, code) => {
  const world = fixture();
  change(world);
  const before = cloneWorld(world);
  expect(equipmentTrade.check(deepFreeze(world), actor, horse)?.code).toBe(code);
  expect(() => equipmentTrade.execute(world, actor, horse, createRng('failed-trade'))).toThrow();
  expect(world).toEqual(before);
});

it.each([
  { slot: 'horse', itemKey: 'none' },
  { slot: 'horse', itemKey: 'horse_06' },
  { slot: 'horse', itemKey: 'weapon_01' },
  { slot: 'head', itemKey: 'horse_01' },
  { ...horse, extra: true },
])('AC-P2-12 빈 칸·없는 장비·잘못된 인자를 거부한다: %j', (args) => {
  expect(equipmentTrade.check(fixture(), actor, args)).not.toBeNull();
});

it('AC-P2-12 장수 부재와 판매 금 한도를 실행 전에 거부한다', () => {
  const world = fixture();
  expect(equipmentTrade.check(world, { generalId: 999 }, horse)?.code).toBe('NO_ACTOR');
  world.equipment!.generals['1'] = { horse: 'horse_01' };
  world.generals[1]!.gold = EQUIPMENT_MAX;
  expect(equipmentTrade.check(world, actor, { slot: 'horse', itemKey: 'none' })?.code).toBe('BAD_STATE');
});
