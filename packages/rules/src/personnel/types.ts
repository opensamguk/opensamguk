import type { DeepReadonly, WorldState } from '../model/world';
export type { AssignmentOffer } from '../model/world';

// 발령 제안의 기한과 거절 벌점.
export const ASSIGNMENT_EXPIRY_MONTHS = 2;
export const ASSIGNMENT_REJECT_PERCENT = 10;

export type PersonnelState = WorldState;
export type PersonnelView = DeepReadonly<PersonnelState>;
export type CancelReason = 'NATION_DESTROYED' | 'CITY_LOST' | 'TARGET_LEFT' | 'ISSUER_LOST_OFFICE';
type Closure = { id: string; resolvedTick: number };
export type ClosedOffer = Closure &
  (
    | { status: 'ACCEPTED'; resolvedBy: 'RESPONSE' | 'EXPIRY'; cancelReason: null }
    | { status: 'REJECTED'; resolvedBy: 'RESPONSE'; cancelReason: null }
    | { status: 'SUPERSEDED'; resolvedBy: null; cancelReason: null }
    | { status: 'CANCELLED'; resolvedBy: null; cancelReason: CancelReason }
  );
export interface PersonnelLog {
  generalId: number;
  commandKey:
    'personnel.appoint' | 'personnel.dismiss' | 'nation_assign' | 'offer.respond' | 'offer.expire' | 'offer.cancel';
  kind: 'success';
  text: string;
}
export interface PersonnelChange {
  state: PersonnelState;
  closedOffers: ClosedOffer[];
  logs: PersonnelLog[];
}
export type PersonnelFailure = {
  ok: false;
  code:
    'NO_ACTOR' | 'NOT_NATION' | 'NOT_RULER' | 'BAD_ARGS' | 'BAD_TARGET' | 'BAD_STATE' | 'OFFER_CLOSED' | 'NOT_ALLOWED';
  message: string;
};
export type PersonnelResult<T> = (PersonnelChange & { ok: true; result: T }) | PersonnelFailure;
export type AppointResult = { generalId: number; officerLevel: number; title: string };
export type RespondResult = {
  offerStatus: 'ACCEPTED' | 'REJECTED';
  city: { cityKey: number; name: string };
  dedicationLost: number;
};

// 사전 검사를 통과한 PENDING이 깨졌으면 저장을 중단한다.
export class PersonnelInvariantError extends Error {}

export function assertTick(tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new PersonnelInvariantError('인사 처리 tick이 잘못됐습니다.');
}

export function clonePersonnel(view: PersonnelView): PersonnelState {
  return structuredClone(view) as PersonnelState;
}

export function removeOffer(state: PersonnelState, targetGeneralId: number): void {
  if (!state.assignmentOffers) return;
  delete state.assignmentOffers[targetGeneralId];
  if (Object.keys(state.assignmentOffers).length === 0) delete state.assignmentOffers;
}

export function personnelFailure(code: PersonnelFailure['code'], message: string): PersonnelFailure {
  return { ok: false, code, message };
}
