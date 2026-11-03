import type { WorldView } from '../model/world';
import { readEquipmentState } from './state';

export function equipmentBonus(world: WorldView, generalId: number) {
  const bonus = { leadership: 0, strength: 0, intel: 0 };
  if (!world.ruleFeatures?.includes('equipment-v1')) return bonus;
  const state = readEquipmentState(world.equipment, world),
    equipped = state.generals[String(generalId)];
  if (equipped)
    for (const key of Object.values(equipped)) {
      const item = state.config.items.find((item) => item.key === key)!;
      bonus[item.stat] += item.bonus;
    }
  return bonus;
}
