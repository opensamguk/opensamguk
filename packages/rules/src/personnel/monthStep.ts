import type { DeepReadonly } from '../model/world';
import { expirePersonnelMonth } from './month';
import { runNpcPersonnelMonth, type NpcPersonnelHistory, type ResidenceAnchors } from './npcMonth';
import type { OfficeRevisions, OfficeView } from './offices';
import { updateResidenceAnchors } from './residence';
import { completePersonnelStep, type PersonnelStepPacket } from './step';

export type PersonnelMonthInput = Readonly<{
  before: OfficeView;
  startOffices: DeepReadonly<OfficeRevisions>;
  settled: OfficeView;
  anchors: ResidenceAnchors;
  tick: number;
}>;
export type PersonnelMonthResult = Readonly<{
  packet: PersonnelStepPacket;
  anchors: Record<number, number>;
  history: readonly NpcPersonnelHistory[];
}>;

// caller가 월간·조약 정산을 마친 상태를 넘긴다. 마무리는 여기서 한 번 수행한다.
export function runPersonnelMonth(input: PersonnelMonthInput): PersonnelMonthResult {
  const { before, startOffices, settled, anchors, tick } = input;
  const raw = expirePersonnelMonth(settled, startOffices, tick);
  const npc = runNpcPersonnelMonth({ before, raw, anchors, tick });
  const packet = completePersonnelStep(before, startOffices, npc.raw, tick);
  const nextAnchors = updateResidenceAnchors({ before, after: packet.state, anchors, tick, createdHumanId: null });
  return { packet, anchors: nextAnchors, history: npc.history };
}
