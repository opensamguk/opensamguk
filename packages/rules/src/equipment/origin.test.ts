import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { STANDARD_EQUIPMENT_CONFIG } from './catalog';
import { initialEquipment } from './state';
import { readStoredEquipment } from './origin';

function fixture() {
  const state = commandWorld();
  state.equipment = initialEquipment(STANDARD_EQUIPMENT_CONFIG);
  state.equipment.generals['1'] = { weapon: 'weapon_06' };
  const world = {
    replayFormat: 3,

    equipmentState: structuredClone(state.equipment),
    replayOrigin: {
      version: 3,
      initial: {},
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
it.each(['format', 'missing', 'config', 'owner', 'exited', 'empty'])('AC-P2-12 %s 손상을 보정하지 않는다', (kind) => {
  const { state, world } = fixture();
  if (kind === 'format') world.replayFormat = 1;
  if (kind === 'missing') Object.assign(world, { equipmentState: null });

  if (kind === 'config') world.equipmentState.config.sellRateBp--;
  if (kind === 'owner') delete state.generals[1];
  if (kind === 'exited') state.generals[1]!.activeFromYear = 2147483647;
  if (kind === 'empty') world.equipmentState.generals['1'] = {};
  expect(() => readStoredEquipment(world, state)).toThrow();
});
