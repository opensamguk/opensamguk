import { TICKS_PER_MONTH } from '../clock/constants';
import { canExecuteNationCommand } from './permissions';
import {
  ASSIGNMENT_EXPIRY_MONTHS,
  ASSIGNMENT_REJECT_PERCENT,
  PersonnelInvariantError,
  assertTick,
  clonePersonnel,
  personnelFailure,
  removeOffer,
} from './types';
import type {
  AssignmentOffer,
  CancelReason,
  PersonnelChange,
  PersonnelResult,
  PersonnelView,
  RespondResult,
} from './types';

export type AssignmentResult = { offerId: string | null; cityKey: number; pending: boolean };

export function assignmentRejectCost(dedication: number): number {
  if (!Number.isSafeInteger(dedication) || dedication < 0)
    throw new PersonnelInvariantError('공헌은 0 이상의 정수여야 합니다.');
  // applyEffects의 공헌 add와 같이 차감 후 잔액을 반올림한다.
  return dedication - Math.round(dedication - (dedication * ASSIGNMENT_REJECT_PERCENT) / 100);
}

// 국가가 사라졌으면 다른 취소 조건보다 먼저 판정한다.
export function assignmentCancelReason(
  view: PersonnelView,
  targetGeneralId: number,
  offer: AssignmentOffer,
): CancelReason | null {
  if (!view.nations[offer.nationId]) return 'NATION_DESTROYED';
  if (view.cities[offer.cityKey]?.nationId !== offer.nationId) return 'CITY_LOST';
  if (view.generals[targetGeneralId]?.nationId !== offer.nationId) return 'TARGET_LEFT';
  const issuer = view.generals[offer.issuerGeneralId];
  if (!issuer || issuer.nationId !== offer.nationId || !canExecuteNationCommand(issuer.officerLevel, 'nation_assign'))
    return 'ISSUER_LOST_OFFICE';
  return null;
}

function pendingOffers(view: PersonnelView): [number, AssignmentOffer][] {
  return Object.entries(view.assignmentOffers ?? {})
    .map(([targetGeneralId, offer]): [number, AssignmentOffer] => [Number(targetGeneralId), offer])
    .sort(([a], [b]) => a - b);
}

export function assignGeneral(
  view: PersonnelView,
  actorId: number,
  generalId: number,
  cityKey: number,
  tick: number,
): PersonnelResult<AssignmentResult> {
  assertTick(tick);
  const actor = view.generals[actorId];
  if (!actor) return personnelFailure('NO_ACTOR', '장수가 없습니다.');
  if (actor.nationId === null || !view.nations[actor.nationId])
    return personnelFailure('NOT_NATION', '국가에 소속되어야 합니다.');
  if (!canExecuteNationCommand(actor.officerLevel, 'nation_assign'))
    return personnelFailure('NOT_ALLOWED', '발령 권한이 없습니다.');
  const target = view.generals[generalId];
  const city = view.cities[cityKey];
  if (!target || target.nationId !== actor.nationId || !city || city.nationId !== actor.nationId)
    return personnelFailure('BAD_TARGET', '소속 장수와 자기 국가 도시를 골라야 합니다.');
  const previous = view.assignmentOffers?.[generalId];
  if (previous && assignmentCancelReason(view, generalId, previous))
    throw new PersonnelInvariantError('발령 전에 유효하지 않은 제안을 닫아야 합니다.');
  const id = `${tick}-${actorId}-${generalId}`;
  if (previous?.id === id) throw new PersonnelInvariantError('같은 tick의 발령 제안 ID가 겹칩니다.');
  const expiresTick = tick + ASSIGNMENT_EXPIRY_MONTHS * TICKS_PER_MONTH;
  if (!Number.isSafeInteger(expiresTick)) throw new PersonnelInvariantError('발령 기한 tick이 범위를 넘습니다.');
  const state = clonePersonnel(view);
  const changed: PersonnelChange = { state, closedOffers: [], logs: [] };
  if (previous) {
    removeOffer(state, generalId);
    changed.closedOffers.push({
      id: previous.id,
      status: 'SUPERSEDED',
      resolvedBy: null,
      resolvedTick: tick,
      cancelReason: null,
    });
  }
  if (target.userId === null) {
    state.generals[generalId]!.cityKey = cityKey;
    changed.logs.push({
      generalId,
      commandKey: 'nation_assign',
      kind: 'success',
      text: `${target.name} ${city.name} 발령`,
    });
  } else {
    state.assignmentOffers ??= {};
    state.assignmentOffers[generalId] = {
      id,
      nationId: actor.nationId,
      issuerGeneralId: actorId,
      cityKey,
      createdTick: tick,
      expiresTick,
    };
    changed.logs.push({
      generalId,
      commandKey: 'nation_assign',
      kind: 'success',
      text: `${city.name} 발령 제안이 왔습니다.`,
    });
  }
  return {
    ok: true,
    ...changed,
    result: { offerId: target.userId === null ? null : id, cityKey, pending: target.userId !== null },
  };
}

export function respondAssignment(
  view: PersonnelView,
  actorId: number,
  offerId: string,
  accept: boolean,
  tick: number,
): PersonnelResult<RespondResult> {
  assertTick(tick);
  if (typeof accept !== 'boolean' || typeof offerId !== 'string')
    return personnelFailure('BAD_ARGS', '발령 응답이 잘못됐습니다.');
  const target = view.generals[actorId];
  if (!target) return personnelFailure('NO_ACTOR', '장수가 없습니다.');
  const offer = view.assignmentOffers?.[actorId];
  if (!offer || offer.id !== offerId) return personnelFailure('OFFER_CLOSED', '응답할 발령 제안이 없습니다.');
  if (assignmentCancelReason(view, actorId, offer))
    throw new PersonnelInvariantError('응답 전에 유효하지 않은 제안을 닫아야 합니다.');
  const state = clonePersonnel(view);
  const changed = state.generals[actorId]!;
  const dedicationLost = accept ? 0 : assignmentRejectCost(changed.dedication);
  if (accept) changed.cityKey = offer.cityKey;
  else changed.dedication -= dedicationLost;
  const city = state.cities[changed.cityKey];
  if (!city) throw new PersonnelInvariantError('발령 응답 장수의 도시가 없습니다.');
  removeOffer(state, actorId);
  const offerStatus = accept ? 'ACCEPTED' : 'REJECTED';
  return {
    ok: true,
    state,
    result: { offerStatus, city: { cityKey: city.cityKey, name: city.name }, dedicationLost },
    closedOffers: [
      { id: offer.id, status: offerStatus, resolvedBy: 'RESPONSE', resolvedTick: tick, cancelReason: null },
    ],
    logs: [
      {
        generalId: actorId,
        commandKey: 'offer.respond',
        kind: 'success',
        text: accept ? `${city.name} 발령 수락` : `발령 거절, 공헌 ${dedicationLost} 감소`,
      },
    ],
  };
}

const cancelText: Record<CancelReason, string> = {
  NATION_DESTROYED: '국가가 멸망해 발령 제안이 취소됐습니다.',
  CITY_LOST: '목표 도시를 잃어 발령 제안이 취소됐습니다.',
  TARGET_LEFT: '국가를 떠나 발령 제안이 취소됐습니다.',
  ISSUER_LOST_OFFICE: '발령자가 직책을 잃어 발령 제안이 취소됐습니다.',
};

// 모든 상태 변경 step 끝에서 syncOffices 뒤에 호출한다. tick은 그 step의 게임 시각이다.
export function closeInvalidOffers(view: PersonnelView, tick: number): PersonnelChange {
  assertTick(tick);
  const state = clonePersonnel(view);
  const result: PersonnelChange = { state, closedOffers: [], logs: [] };
  for (const [generalId, offer] of pendingOffers(view)) {
    const reason = assignmentCancelReason(view, generalId, offer);
    if (!reason) continue;
    removeOffer(state, generalId);
    result.closedOffers.push({
      id: offer.id,
      status: 'CANCELLED',
      resolvedBy: null,
      resolvedTick: tick,
      cancelReason: reason,
    });
    result.logs.push({ generalId, commandKey: 'offer.cancel', kind: 'success', text: cancelText[reason] });
  }
  return result;
}

// 기존 월간 처리 뒤에 호출한다. U2 취소가 같은 달의 기한 수락보다 먼저다.
export function expireAssignments(view: PersonnelView, tick: number): PersonnelChange {
  const result = closeInvalidOffers(view, tick);
  for (const [generalId, offer] of pendingOffers(result.state)) {
    if (offer.expiresTick > tick) continue;
    const target = result.state.generals[generalId]!;
    target.cityKey = offer.cityKey;
    removeOffer(result.state, generalId);
    result.closedOffers.push({
      id: offer.id,
      status: 'ACCEPTED',
      resolvedBy: 'EXPIRY',
      resolvedTick: tick,
      cancelReason: null,
    });
    result.logs.push({
      generalId,
      commandKey: 'offer.expire',
      kind: 'success',
      text: `${result.state.cities[offer.cityKey]!.name} 발령 기한이 지나 수락했습니다.`,
    });
  }
  return result;
}
