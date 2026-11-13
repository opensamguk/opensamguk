import type { WorldState } from '../model/world';
import { MORALE_TOOL, TRAINING_TOOL, hasMoraleTool } from './config';

// Apply only to a participant in an actual battle. The command owns this cloned state.
export function useBattleTool(state: WorldState, generalId: number, force: { atmos: number; train: number }) {
  const equipment = state.equipment;
  const slots = equipment?.generals[generalId];
  if (!equipment || !slots?.tool) return;
  if (slots.tool.key === MORALE_TOOL.key && hasMoraleTool(equipment.config))
    force.atmos = Math.min(100, force.atmos + MORALE_TOOL.morale);
  else if (slots.tool.key === TRAINING_TOOL.key && 'fullRareEquipment' in equipment.config)
    force.train = Math.min(100, force.train + TRAINING_TOOL.train);
  else return;
  consumeBattleTool(state, generalId);
}

export function consumeBattleTool(state: WorldState, generalId: number) {
  const equipment = state.equipment!;
  const remaining = { ...equipment.generals[generalId]! };
  delete remaining.tool;
  if (Object.keys(remaining).length > 0) equipment.generals[generalId] = remaining;
  else delete equipment.generals[generalId];
}
