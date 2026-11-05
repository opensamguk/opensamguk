import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { STANDARD_EQUIPMENT_CONFIG } from './catalog';
import { initialEquipment } from './state';
import { readStoredEquipment } from './origin';

function fixture() {
  const state = commandWorld();
  state.ruleFeatures = ['campaign-v1', 'equipment-v1', 'five-stats', 'logistics-v1'];
  state.equipment = initialEquipment(STANDARD_EQUIPMENT_CONFIG);
  state.equipment.generals['1'] = { weapon: 'weapon_06' };
  const world = {
    replayFormat: 3,
    ruleFeatures: [...state.ruleFeatures],
    equipmentState: structuredClone(state.equipment),
    replayOrigin: {
      version: 3,
      initial: { ruleFeatures: [...state.ruleFeatures] },
      featureData: { 'equipment-v1': structuredClone(STANDARD_EQUIPMENT_CONFIG) },
    },
  };
  return { state, world };
}
it('AC-P2-12 원생성과 같은 카탈로그·실제 장수 장착만 복원하고 원문을 바꾸지 않는다', () => {
  const { state, world } = fixture(),
    before = structuredClone(world);
  expect(readStoredEquipment(world, state)).toEqual(state.equipment);
  expect(world).toEqual(before);
});
it('AC-P2-12 꺼진 월드의 누락 상태는 허용하고 남은 장착 상태는 거부한다', () => {
  const { state, world } = fixture();
  expect(readStoredEquipment({ ...world, ruleFeatures: [], equipmentState: null }, state)).toBeUndefined();
  expect(() => readStoredEquipment({ ...world, ruleFeatures: [] }, state)).toThrow('끈');
});
it.each(['campaign-v1', 'five-stats', 'logistics-v1'])('AC-P2-12 %s 의존이 없는 저장은 거부한다', (key) => {
  const { state, world } = fixture();
  world.ruleFeatures = world.ruleFeatures.filter((entry) => entry !== key);
  expect(() => readStoredEquipment(world, state)).toThrow('의존');
});
it.each(['format', 'originFlags', 'viewFlags', 'config', 'owner', 'exited', 'empty'])(
  'AC-P2-12 %s 손상을 보정하지 않는다',
  (kind) => {
    const { state, world } = fixture();
    if (kind === 'format') world.replayFormat = 1;
    if (kind === 'originFlags') world.replayOrigin.initial.ruleFeatures = [];
    if (kind === 'viewFlags') state.ruleFeatures = [];
    if (kind === 'config') world.equipmentState.config.sellRateBp--;
    if (kind === 'owner') delete state.generals[1];
    if (kind === 'exited') state.generals[1]!.activeFromYear = 2147483647;
    if (kind === 'empty') world.equipmentState.generals['1'] = {};
    expect(() => readStoredEquipment(world, state)).toThrow();
  },
);
