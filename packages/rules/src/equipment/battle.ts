import type { WorldView } from '../model/world';

export type EquipmentBattleEffects = {
  extraPhases?: number;
  damageFactor?: number;
  riceFactor?: number;
  evasionLeadership?: number;
  tacticsTrial?: number;
  opposingTacticsSuccess?: number;
  tacticsDamageFactor?: number;
  counterTactics?: number;
};

// core2026 c81d304, packages/logic/src/items (MIT).
export function equipmentBattleEffects(world: WorldView, generalId: number): EquipmentBattleEffects | undefined {
  const equipment = world.equipment;
  if (!equipment || !('fullRareEquipment' in equipment.config)) return undefined;
  const slots = equipment.generals[String(generalId)];
  if (!slots) return undefined;
  const effects: EquipmentBattleEffects = {};
  switch (slots.horse) {
    case 'horse_07_기주마':
      effects.extraPhases = 1;
      break;
    case 'horse_07_백상':
      Object.assign(effects, { extraPhases: -1, damageFactor: 1.2, riceFactor: 1.1 });
      break;
    case 'horse_12_옥란백용구':
      effects.evasionLeadership = world.generals[generalId]!.leadership + 12;
      break;
  }
  switch (slots.book) {
    case 'book_07_위료자':
      effects.tacticsTrial = 0.2;
      break;
    case 'book_07_논어':
    case 'book_11_춘추전':
      effects.opposingTacticsSuccess = -0.1;
      break;
    case 'book_08_전론':
      effects.tacticsDamageFactor = 1.2;
      break;
    case 'book_07_사마법':
    case 'book_12_산해경':
      effects.counterTactics = 0.1;
      break;
  }
  return effects;
}
