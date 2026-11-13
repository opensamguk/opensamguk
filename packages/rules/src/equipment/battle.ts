import type { WorldState, WorldView } from '../model/world';
import type { EquipmentConfig } from './config';
import { consumeBattleTool } from './morale';

export type EquipmentBattleEffects = {
  extraPhases?: number;
  damageFactor?: number;
  riceFactor?: number;
  evasionLeadership?: number;
  tacticsTrial?: number;
  opposingTacticsSuccess?: number;
  tacticsDamageFactor?: number;
  counterTactics?: number;
  snipe?: { chance: number; morale: number; injury: readonly [min: number, max: number] };
};

const standardBookTrial = (key: string | undefined) => {
  const grade = /^book_0([1-6])$/.exec(key ?? '')?.[1];
  return grade ? Math.ceil(Number(grade) / 2) : 0;
};
const shortBow = { chance: 0.01, morale: 20, injury: [10, 30] } satisfies EquipmentBattleEffects['snipe'];

// core2026 c81d304, packages/logic/src/items (MIT).
export function equipmentBattleEffects(world: WorldView, generalId: number): EquipmentBattleEffects | undefined {
  const equipment = world.equipment;
  if (!equipment || !('fullRareEquipment' in equipment.config)) return undefined;
  const slots = equipment.generals[String(generalId)];
  if (!slots) return undefined;
  const effects: EquipmentBattleEffects = {};
  const bookTrial = standardBookTrial(slots.book);
  if (bookTrial) effects.tacticsTrial = bookTrial / 100;
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
  switch (slots.weapon) {
    case 'weapon_02':
      effects.snipe = shortBow;
      break;
    case 'weapon_07_맥궁':
    case 'weapon_09_동호비궁':
      effects.snipe = { chance: 0.2, morale: 20, injury: [20, 40] };
      break;
    case 'weapon_11_이광궁':
    case 'weapon_13_양유기궁':
      effects.snipe = { chance: 0.1, morale: 10, injury: [20, 40] };
      break;
  }
  if (slots.tool?.key === 'tool_06') effects.snipe = { chance: 1, morale: 20, injury: [20, 40] };
  return effects;
}

export function consumeSnipeTool(state: WorldState, generalId: number, fired: boolean | undefined) {
  if (fired && state.equipment?.generals[generalId]?.tool?.key === 'tool_06') consumeBattleTool(state, generalId);
}

export function regularEquipmentBattleDescription(config: Readonly<EquipmentConfig>, key: string) {
  if (!('fullRareEquipment' in config)) return undefined;
  if (key === 'weapon_02') return `교전 시작 시 ${shortBow.chance * 100}% 확률로 저격하고 사기 +${shortBow.morale}.`;
  const trial = standardBookTrial(key);
  return trial ? `전투 계략 시도 확률 +${trial}%p.` : undefined;
}
