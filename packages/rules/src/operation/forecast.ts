import type { WorldView } from '../model/world';
import { choosePolicyCommand, type PolicyKey, type PolicySlot } from '../policy';
import { calculateOperationTimeline, prepareOperationReadiness, type OperationTimelineInput } from './timeline';

export interface OperationForecastInput extends Omit<OperationTimelineInput, 'turns'> {
  turns: readonly PolicySlot[];
  view: WorldView;
  generalId: number;
  policy: PolicyKey;
  policyMode: boolean;
}

export function calculateOperationForecast(input: OperationForecastInput) {
  const stored = calculateOperationTimeline(input);
  const effective = structuredClone([...input.turns]);
  const expected = { ...input.current };
  const general = input.view.generals[input.generalId];
  for (const cell of stored.cells) {
    if (cell === stored.sortie) break;
    let turn = effective[cell.slot]!;
    if (!turn.explicit) {
      turn = { commandKey: 'rest', args: {}, explicit: false };
      if (input.policyMode && general?.userId != null) {
        const view: WorldView = {
          ...input.view,
          generals: { ...input.view.generals, [input.generalId]: { ...general, ...expected } },
        };
        const selected = choosePolicyCommand(view, input.generalId, input.policy);
        if (selected) turn = { ...selected, explicit: false };
      }
      effective[cell.slot] = turn;
    }
    prepareOperationReadiness(expected, turn);
  }
  const result = calculateOperationTimeline({ ...input, turns: effective });
  // 표시 칸은 저장된 명령을 유지한다. 방침 선택은 예상값에만 쓴다.
  return { ...result, cells: stored.cells, sortie: stored.sortie };
}
