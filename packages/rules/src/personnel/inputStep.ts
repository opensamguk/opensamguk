import type { DeepReadonly } from '../model/world';
import {
  applyNationTurnsRecord,
  applyPersonnelInput,
  replayPersonnelInput,
  type AppliedPersonnelInput,
  type PendingPersonnelEvent,
  type PersonnelInputContext,
  type PersonnelInputOutcome,
  type PersonnelRecordedInput,
} from './inputs';
import type { OfficeRevisions, OfficeState, OfficeView } from './offices';
import { completePersonnelStep, type PersonnelStepPacket } from './step';
import { assertTick, PersonnelInvariantError } from './types';

export type PersonnelInputStep =
  | Readonly<{ status: 'REJECTED'; result: Extract<PersonnelInputOutcome, { status: 'REJECTED' }>['result'] }>
  | Readonly<{ status: 'APPLIED'; result: AppliedPersonnelInput['result']; packet: PersonnelStepPacket }>;

export function applyPersonnelInputStep(
  view: OfficeView,
  offices: DeepReadonly<OfficeRevisions>,
  event: PendingPersonnelEvent,
  context: PersonnelInputContext,
): PersonnelInputStep {
  const outcome = applyPersonnelInput(view, event, context);
  if (outcome.status === 'REJECTED') return outcome;
  return {
    status: 'APPLIED',
    result: outcome.result,
    packet: completePersonnelStep(view, offices, { ...outcome.change, offices }, context.tick),
  };
}

export function applyPersonnelRecordStep(
  current: Readonly<{ state: OfficeView; offices: DeepReadonly<OfficeRevisions> }>,
  record: PersonnelRecordedInput,
  tick: number,
): Readonly<{ state: OfficeState; offices: OfficeRevisions; packet: PersonnelStepPacket }> {
  assertTick(tick);
  if (record.status !== 'APPLIED') throw new PersonnelInvariantError('인사 입력을 재생할 수 없습니다.');
  let packet: PersonnelStepPacket;
  if (record.kind === 'nationTurns.set') {
    const edited = applyNationTurnsRecord(current.state, current.offices, record);
    packet = completePersonnelStep(current.state, current.offices, { ...edited, closedOffers: [], logs: [] }, tick);
  } else {
    if (tick !== record.result.tick) throw new PersonnelInvariantError('인사 입력 tick이 기록과 다릅니다.');
    const change = replayPersonnelInput(current.state, record);
    packet = completePersonnelStep(current.state, current.offices, { ...change, offices: current.offices }, tick);
  }
  return { state: packet.state, offices: packet.offices, packet };
}
