import type { WorldView } from '../model/world';
import { equippedItem } from './config';
import type { FiveStats } from '../general/fiveStats';

export function equipmentBonus(world: WorldView, generalId: number) {
  const bonus = { leadership: 0, strength: 0, intel: 0 };
  if (!world.ruleFeatures?.includes('equipment-v1')) return bonus;
  const state = world.equipment;
  if (!state) throw new Error('장비 판의 장착 상태가 없습니다.');
  // 전체 원장의 경계 검증을 전제로 한 장수 행과 최대18종만 읽는다.
  const equipped = state.generals[String(generalId)];
  if (equipped)
    for (const [slot, key] of Object.entries(equipped)) {
      if (slot === 'tool') continue;
      const item = typeof key === 'string' ? equippedItem(state.config, key) : undefined;
      if (!item || item.slot !== slot) throw new Error('장착한 장비의 번호와 칸이 맞지 않습니다.');
      bonus[item.stat] += item.bonus;
    }
  return bonus;
}

// D-070: 검증한 기본 능력치는 그대로 두고 계산할 때만 장비를 더한다.
export function withEquipmentBonus(world: WorldView, generalId: number, stats: FiveStats): FiveStats {
  if (!world.ruleFeatures?.includes('equipment-v1')) return stats;
  const bonus = equipmentBonus(world, generalId);
  return {
    ...stats,
    leadership: stats.leadership + bonus.leadership,
    strength: stats.strength + bonus.strength,
    intel: stats.intel + bonus.intel,
  };
}
