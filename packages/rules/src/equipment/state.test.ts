import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { cloneWorld } from '../model/clone';
import { LINEAGE_EXITED_YEAR } from '../lineage/config';
import { lineageFixture } from '../lineage/testFixture';
import { EQUIPMENT_MAX, equipmentConfigSchema } from './config';
import { initialEquipment, readEquipmentState } from './state';
import { equipmentBonus } from './stats';
import { TEST_EQUIPMENT_CONFIG } from './testFixture';

const fixture = () => {
  const world = commandWorld();
  world.ruleFeatures = ['equipment-v1'];
  world.equipment = initialEquipment(TEST_EQUIPMENT_CONFIG);
  return world;
};

it('AC-P2-12 명시 config만 받아 독립된 빈 장착 상태를 만든다', () => {
  const world = fixture();
  expect(world.equipment!.generals).toEqual({});
  expect(readEquipmentState(world.equipment, world)).toEqual(world.equipment);
  expect(world.equipment!.config).not.toBe(TEST_EQUIPMENT_CONFIG);
  expect(equipmentConfigSchema.safeParse({ version: 1 }).success).toBe(false);
});

it.each([
  { sellRateBp: 10_001 },
  { sellRateBp: -1 },
  { tradeExperience: EQUIPMENT_MAX + 1 },
  { tradeExperience: 0.5 },
  { items: [] },
  { items: [TEST_EQUIPMENT_CONFIG.items[0], TEST_EQUIPMENT_CONFIG.items[0]] },
])('AC-P2-12 비율·DB 정수·중복 번호의 잘못된 config %j를 거부한다', (change) => {
  expect(equipmentConfigSchema.safeParse({ ...TEST_EQUIPMENT_CONFIG, ...change }).success).toBe(false);
});

it.each([
  { key: 'horse_02' },
  { stat: 'strength' },
  { name: '   ' },
  { goods: { iron: 0, wood: 0, horses: EQUIPMENT_MAX + 1 } },
  { bonus: 7 },
])('AC-P2-12 칸·등급·능력치와 재화 한도가 맞지 않는 항목 %j를 거부한다', (change) => {
  const config = structuredClone(TEST_EQUIPMENT_CONFIG);
  expect(equipmentConfigSchema.safeParse({ ...config, items: [{ ...config.items[0], ...change }] }).success).toBe(
    false,
  );
});

it.each(['0', '01', String(EQUIPMENT_MAX + 1), '999', '__proto__', 'constructor', 'prototype'])(
  'AC-P2-12 유효한 주인이 아닌 %s의 장비를 거부한다',
  (key) => {
    const world = fixture();
    world.equipment!.generals = Object.fromEntries([[key, { horse: 'horse_01' }]]);
    expect(() => readEquipmentState(world.equipment, world)).toThrow();
  },
);

it.each([{}, { horse: undefined }, { horse: 'horse_02' }, { weapon: 'horse_01' }, { other: 'horse_01' }])(
  'AC-P2-12 빈 행·미등록 장비·다른 칸 %j를 거부한다',
  (slots) => {
    const world = fixture();
    expect(() => readEquipmentState({ ...world.equipment, generals: { '1': slots } }, world)).toThrow();
  },
);

it('AC-P2-12 퇴장 장수의 장비는 저장 상태로 받지 않는다', () => {
  const world = fixture();
  world.equipment!.generals['1'] = { horse: 'horse_01' };
  world.generals[1]!.activeFromYear = LINEAGE_EXITED_YEAR;
  expect(() => readEquipmentState(world.equipment, world)).toThrow('퇴장');
});

it('AC-P2-12 장수 표의 번호가 주인 번호와 다르면 장착을 거부한다', () => {
  const world = fixture();
  world.equipment!.generals['1'] = { horse: 'horse_01' };
  world.generals[1]!.id = 2;
  expect(() => readEquipmentState(world.equipment, world)).toThrow('주인');
});

it('AC-P2-12 퇴장 기록과 활성 연도가 어긋난 손상 상태에서도 장비를 거부한다', () => {
  const world = lineageFixture();
  world.equipment = initialEquipment(TEST_EQUIPMENT_CONFIG);
  world.equipment.generals['1'] = { horse: 'horse_01' };
  world.lineage!.persons['1'] = {
    parents: [],
    bornTick: null,
    successorId: null,
    heirId: null,
    exit: { tick: 0, cause: 'DIED', activeFromYear: world.generals[1]!.activeFromYear },
  };
  expect(world.generals[1]!.activeFromYear).not.toBe(LINEAGE_EXITED_YEAR);
  expect(() => readEquipmentState(world.equipment, world)).toThrow('퇴장');
});

it('AC-P2-12 자기 장착만 합산하고 저장 능력치와 다른 장수를 바꾸지 않는다', () => {
  const world = fixture();
  world.equipment!.generals['1'] = { horse: 'horse_01', weapon: 'weapon_01', book: 'book_01' };
  const before = structuredClone(world);
  expect(equipmentBonus(world, 1)).toEqual({ leadership: 1, strength: 2, intel: 3 });
  expect(equipmentBonus(world, 2)).toEqual({ leadership: 0, strength: 0, intel: 0 });
  expect(world).toEqual(before);
});

it('AC-P2-12 끈 판에서는 주입된 장착을 계산하지 않고 없는 상태 칸도 만들지 않는다', () => {
  const world = commandWorld(),
    before = structuredClone(world);
  expect(equipmentBonus(world, 1)).toEqual({ leadership: 0, strength: 0, intel: 0 });
  expect(Object.hasOwn(cloneWorld(world), 'equipment')).toBe(false);
  expect(world).toEqual(before);
  world.equipment = initialEquipment(TEST_EQUIPMENT_CONFIG);
  world.equipment.generals['1'] = { book: 'book_01' };
  expect(equipmentBonus(world, 1).intel).toBe(0);
  world.ruleFeatures = ['equipment-v1'];
  delete world.equipment;
  expect(() => equipmentBonus(world, 1)).toThrow();
});

it('AC-P2-12 복사한 장착과 카탈로그를 바꿔도 앞선 상태는 보존한다', () => {
  const world = fixture();
  world.equipment!.generals['1'] = { horse: 'horse_01' };
  const before = structuredClone(world),
    copy = cloneWorld(world);
  delete copy.equipment!.generals['1'];
  copy.equipment!.config.items[0]!.cost = 99;
  expect(world).toEqual(before);
});
