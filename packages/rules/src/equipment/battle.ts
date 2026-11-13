import type { WorldState, WorldView } from '../model/world';
import { EQUIPMENT_MAX, rareEquipmentTools, type EquipmentConfig } from './config';
import type { Rng } from '@opensamguk/shared';
import type { InitialGeneral } from '../world/bootstrap';
import { consumeBattleTool } from './morale';

export type EquipmentBattleEffects = {
  extraPhases?: number;
  damageFactor?: number;
  riceFactor?: number;
  evasionLeadership?: number;
  protectsFromBattleInjury?: true;
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
  const effects: EquipmentBattleEffects = {};
  if (!slots) return effects;
  const bookTrial = standardBookTrial(slots.book);
  if (bookTrial) effects.tacticsTrial = bookTrial / 100;
  switch (slots.horse) {
    case 'horse_07_기주마':
      effects.extraPhases = 1;
      break;
    case 'horse_07_백마':
    case 'horse_12_사륜거':
      effects.protectsFromBattleInjury = true;
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

// Rival generals can each trigger the jade tool. Resolve both amounts from pre-loot holdings.
export function applyBattleLoot(state: WorldState, attacker: InitialGeneral, defender: InitialGeneral, rng: Rng) {
  const equipment = state.equipment;
  if (!equipment || !('rareTools' in equipment.config) || !equipment.config.rareTools || attacker.id === defender.id)
    return '';
  const tool = rareEquipmentTools.tool_07;
  const attempt = (general: InitialGeneral) =>
    equipment.generals[general.id]?.tool?.key === tool.key && rng.next() < tool.lootChance;
  const attack = attempt(attacker),
    defend = attempt(defender);
  if (!attack && !defend) return '';
  const amounts = (resource: 'gold' | 'rice') => {
    const a = Math.min(Math.floor(defender[resource] * tool.lootShare), EQUIPMENT_MAX - attacker[resource]);
    const d = Math.min(Math.floor(attacker[resource] * tool.lootShare), EQUIPMENT_MAX - defender[resource]);
    const taken = attack ? a : 0,
      lost = defend ? d : 0;
    attacker[resource] += taken - lost;
    defender[resource] += lost - taken;
    return [taken, lost] as const;
  };
  const [aGold, dGold] = amounts('gold');
  const [aRice, dRice] = amounts('rice');
  return [
    ...(attack ? [`${attacker.name} 약탈 · 금 ${aGold} · 쌀 ${aRice}`] : []),
    ...(defend ? [`${defender.name} 약탈 · 금 ${dGold} · 쌀 ${dRice}`] : []),
  ].join(' · ');
}

export function regularEquipmentBattleDescription(config: Readonly<EquipmentConfig>, key: string) {
  if (!('fullRareEquipment' in config)) return undefined;
  if (key === 'weapon_02') return `교전 시작 시 ${shortBow.chance * 100}% 확률로 저격하고 사기 +${shortBow.morale}.`;
  const trial = standardBookTrial(key);
  return trial ? `전투 계략 시도 확률 +${trial}%p.` : undefined;
}
