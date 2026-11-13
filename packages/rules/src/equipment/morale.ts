import type { WorldState } from '../model/world';
import { MORALE_TOOL, hasMoraleTool } from './config';

// Apply only to a participant in an actual battle. The command owns this cloned state.
export function useBattleMoraleTool(state: WorldState, generalId: number, force: { atmos: number }) {
  const equipment = state.equipment;
  const slots = equipment?.generals[generalId];
  if (!equipment || !hasMoraleTool(equipment.config) || slots?.tool?.key !== MORALE_TOOL.key) return;
  force.atmos = Math.min(100, force.atmos + MORALE_TOOL.morale);
  const remaining = { ...slots };
  delete remaining.tool;
  if (Object.keys(remaining).length > 0) equipment.generals[generalId] = remaining;
  else delete equipment.generals[generalId];
}
