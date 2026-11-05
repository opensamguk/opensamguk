import type { WorldState } from '../model/world';
import type { SuccessionMode } from '../lineage/succession';
import { readEquipmentState } from './state';

// 호출자가 복제한 상태만 바꾼다. 사람의 겹치는 칸은 판매 후 다시 계승하도록 보류한다.
export function inheritEquipment(world: WorldState, fromId: number, toId: number | null, mode: SuccessionMode) {
  if (!world.ruleFeatures?.includes('equipment-v1')) return true;
  const state = readEquipmentState(world.equipment, world),
    from = state.generals[String(fromId)],
    to = toId === null ? undefined : state.generals[String(toId)];
  if (mode === 'HUMAN' && from && to && Object.keys(from).some((slot) => Object.hasOwn(to, slot))) return false;
  if (toId !== null && from) state.generals[String(toId)] = { ...from, ...to };
  delete state.generals[String(fromId)];
  world.equipment = state;
  return true;
}
