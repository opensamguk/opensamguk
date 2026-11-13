import { TREATMENT_TOOL, hasTreatmentTool } from './config';
import type { WorldState } from '../model/world';

export function applyPreTurnTreatment(state: WorldState, generalId: number) {
  const equipment = state.equipment;
  const general = state.generals[generalId]!;
  const slots = equipment?.generals[generalId];
  if (
    !equipment ||
    !hasTreatmentTool(equipment.config) ||
    slots?.tool?.key !== TREATMENT_TOOL.key ||
    general.injury < TREATMENT_TOOL.injuryThreshold
  )
    return state;
  const next = structuredClone(state);
  const generals = next.equipment!.generals;
  const equipped = generals[generalId]!;
  const tool = equipped.tool!;
  if (tool.charges === 1) delete equipped.tool;
  else equipped.tool = { key: TREATMENT_TOOL.key, charges: tool.charges - 1 };
  if (Object.keys(equipped).length === 0) delete generals[generalId];
  next.generals[generalId]!.injury = 0;
  return next;
}
