import { TREATMENT_TOOL, hasTreatmentTool } from './config';
import type { WorldState } from '../model/world';

export function applyPreTurnTreatment(state: WorldState, generalId: number) {
  const equipment = state.equipment;
  const general = state.generals[generalId]!;
  const slots = equipment?.generals[generalId];
  if (
    !equipment ||
    !hasTreatmentTool(equipment.config) ||
    !slots?.tool ||
    general.injury < TREATMENT_TOOL.injuryThreshold
  )
    return state;
  const next = structuredClone(state);
  const generals = next.equipment!.generals;
  const equipped = generals[generalId]!;
  if (--equipped.tool!.charges === 0) delete equipped.tool;
  if (Object.keys(equipped).length === 0) delete generals[generalId];
  next.generals[generalId]!.injury = 0;
  return next;
}
