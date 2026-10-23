import type { DeepReadonly } from '../model/world';
import { finishPersonnelStep } from './inputs';
import type { OfficeRevisions, OfficeState, OfficeView } from './offices';
import { assertTick, type ClosedOffer, type PersonnelLog } from './types';

export type PersonnelRawStep = Readonly<{
  state: OfficeView;
  offices: DeepReadonly<OfficeRevisions>;
  closedOffers: readonly ClosedOffer[];
  logs: readonly PersonnelLog[];
}>;
type OfficeSnapshot = Pick<OfficeView, 'officeTurns'> & { offices: OfficeRevisions };
export type PersonnelStepPacket = Readonly<{
  state: OfficeState;
  offices: OfficeRevisions;
  assignment: Readonly<{
    before: Pick<OfficeView, 'assignmentOffers'>;
    beforeFinish: Pick<OfficeView, 'assignmentOffers'>;
    final: Pick<OfficeView, 'assignmentOffers'>;
    closedOffers: readonly ClosedOffer[];
  }>;
  office: Readonly<{ before: OfficeSnapshot; next: OfficeSnapshot }>;
  logs: readonly PersonnelLog[];
}>;

function assignments(view: OfficeView): Pick<OfficeView, 'assignmentOffers'> {
  return view.assignmentOffers === undefined ? {} : { assignmentOffers: structuredClone(view.assignmentOffers) };
}

function officeSnapshot(view: OfficeView, offices: DeepReadonly<OfficeRevisions>): OfficeSnapshot {
  return {
    offices: structuredClone(offices) as OfficeRevisions,
    ...(view.officeTurns === undefined ? {} : { officeTurns: structuredClone(view.officeTurns) }),
  };
}

export function completePersonnelStep(
  before: OfficeView,
  startOffices: DeepReadonly<OfficeRevisions>,
  raw: PersonnelRawStep,
  tick: number,
): PersonnelStepPacket {
  assertTick(tick);
  const initial = assignments(before);
  const witness = assignments(raw.state);
  const officeBefore = officeSnapshot(before, startOffices);
  const finished = finishPersonnelStep(before, raw, raw.offices, tick);
  return {
    state: finished.state,
    offices: finished.offices,
    assignment: {
      before: initial,
      beforeFinish: witness,
      final: assignments(finished.state),
      closedOffers: structuredClone(finished.closedOffers),
    },
    office: { before: officeBefore, next: officeSnapshot(finished.state, finished.offices) },
    logs: structuredClone(finished.logs),
  };
}
