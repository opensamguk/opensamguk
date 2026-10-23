import { describe, expect, it } from 'vitest';
import { applyEffects } from '../commands/effects';
import { TICKS_PER_MONTH } from '../clock/constants';
import { appointOfficer, dismissOfficer } from './appointments';
import {
  assignGeneral,
  assignmentCancelReason,
  assignmentRejectCost,
  closeInvalidOffers,
  expireAssignments,
  respondAssignment,
} from './assignments';
import { applied, deepFreeze, personnelWorld } from './testFixture';
import { PersonnelInvariantError } from './types';
import type { CancelReason, PersonnelState } from './types';

function offered(tick = 123): PersonnelState {
  return applied(assignGeneral(personnelWorld(), 4, 3, 4, tick)).state;
}

describe('발령 제안과 응답', () => {
  it.each([5, 6, 7, 8, 9, 10, 11, 12])('직책 %i는 사람 장수에게 두 달 기한의 제안을 보낸다', (level) => {
    const state = personnelWorld();
    state.generals[4]!.officerLevel = level;
    const outcome = applied(assignGeneral(deepFreeze(state), 4, 3, 4, 123));
    expect(outcome.result).toEqual({ offerId: '123-4-3', cityKey: 4, pending: true });
    expect(outcome.state.assignmentOffers).toEqual({
      3: { id: '123-4-3', nationId: 1, issuerGeneralId: 4, cityKey: 4, createdTick: 123, expiresTick: 20123 },
    });
    expect(outcome.state.generals).toEqual(state.generals);
    expect(outcome.closedOffers).toEqual([]);
    expect(outcome.logs).toHaveLength(1);
    expect(state.assignmentOffers).toBeUndefined();
  });

  it.each([0, 1, 2, 4, 13, NaN])('권한 없는 직책 %s의 발령을 거부한다', (level) => {
    const state = personnelWorld();
    state.generals[4]!.officerLevel = level;
    expect(assignGeneral(deepFreeze(state), 4, 3, 4, 123)).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  });

  it.each([
    [999, 3, 4, 'NO_ACTOR'],
    [4, 999, 4, 'BAD_TARGET'],
    [4, 2, 4, 'BAD_TARGET'],
    [4, 3, 2, 'BAD_TARGET'],
    [4, 3, 3, 'BAD_TARGET'],
    [4, 3, 999, 'BAD_TARGET'],
  ] as const)('발령 대상과 행위자를 검사한다 (%s, %s, %s)', (actor, target, city, code) => {
    const state = deepFreeze(personnelWorld());
    expect(assignGeneral(state, actor, target, city, 123)).toMatchObject({ ok: false, code });
  });

  it('재야와 사라진 국가의 행위자는 발령할 수 없다', () => {
    const state = personnelWorld();
    state.generals[4]!.nationId = null;
    expect(assignGeneral(state, 4, 3, 4, 123)).toMatchObject({ ok: false, code: 'NOT_NATION' });
    state.generals[4]!.nationId = 99;
    expect(assignGeneral(state, 4, 3, 4, 123)).toMatchObject({ ok: false, code: 'NOT_NATION' });
  });

  it('NPC는 즉시 이동하고 제안을 만들지 않는다', () => {
    const state = personnelWorld();
    state.generals[3]!.userId = null;
    const outcome = applied(assignGeneral(deepFreeze(state), 4, 3, 4, 123));
    expect(outcome.result).toEqual({ offerId: null, cityKey: 4, pending: false });
    expect(outcome.state.generals[3]).toEqual({ ...state.generals[3], cityKey: 4 });
    expect(Object.hasOwn(outcome.state, 'assignmentOffers')).toBe(false);
    expect(state.generals[3]!.cityKey).toBe(1);
  });

  it('새 발령은 이전 제안을 벌점 없이 SUPERSEDED로 닫는다', () => {
    const state = offered();
    const previous = structuredClone(state);
    const outcome = applied(assignGeneral(deepFreeze(state), 1, 3, 1, 456));
    expect(outcome.closedOffers).toEqual([
      { id: '123-4-3', status: 'SUPERSEDED', resolvedBy: null, resolvedTick: 456, cancelReason: null },
    ]);
    expect(outcome.state.assignmentOffers).toEqual({
      3: { id: '456-1-3', nationId: 1, issuerGeneralId: 1, cityKey: 1, createdTick: 456, expiresTick: 20456 },
    });
    expect(outcome.state.generals).toEqual(state.generals);
    expect(state).toEqual(previous);
    expect(respondAssignment(outcome.state, 3, '123-4-3', true, 457)).toMatchObject({
      ok: false,
      code: 'OFFER_CLOSED',
    });
  });

  it('같은 tick에 같은 발령 ID를 다시 만들면 저장 전에 멈춘다', () => {
    const state = deepFreeze(offered());
    expect(() => assignGeneral(state, 4, 3, 1, 123)).toThrow(PersonnelInvariantError);
    expect(state.assignmentOffers![3]!.cityKey).toBe(4);
  });

  it('수락하면 이동하고 턴·공헌·직책은 보존한다', () => {
    const state = offered();
    const outcome = applied(respondAssignment(deepFreeze(state), 3, '123-4-3', true, 124));
    expect(outcome.result).toEqual({ offerStatus: 'ACCEPTED', city: { cityKey: 4, name: '도시4' }, dedicationLost: 0 });
    expect(outcome.state.generals[3]).toEqual({ ...state.generals[3], cityKey: 4 });
    expect(outcome.closedOffers).toEqual([
      { id: '123-4-3', status: 'ACCEPTED', resolvedBy: 'RESPONSE', resolvedTick: 124, cancelReason: null },
    ]);
    expect(Object.hasOwn(outcome.state, 'assignmentOffers')).toBe(false);
    expect(respondAssignment(outcome.state, 3, '123-4-3', true, 125)).toMatchObject({
      ok: false,
      code: 'OFFER_CLOSED',
    });
    expect(expireAssignments(outcome.state, 30000).logs).toEqual([]);
  });

  it.each([0, 1, 4, 5, 9, 10, 11, 15, 95, 100, 123, 2147483647])(
    '공헌 %i의 거절은 기존 공헌 효과와 같은 정수 잔액을 남긴다',
    (dedication) => {
      const state = offered();
      state.generals[3]!.dedication = dedication;
      const expected = applyEffects(state, [
        { kind: 'general', id: 3, field: 'dedication', op: 'add', value: -dedication * 0.1 },
      ]).generals[3]!.dedication;
      const outcome = applied(respondAssignment(deepFreeze(state), 3, '123-4-3', false, 124));
      expect(outcome.result).toEqual({
        offerStatus: 'REJECTED',
        city: { cityKey: 1, name: '도시1' },
        dedicationLost: dedication - expected,
      });
      expect(outcome.state.generals[3]).toEqual({ ...state.generals[3], dedication: expected });
      expect(assignmentRejectCost(dedication)).toBe(dedication - expected);
      expect(outcome.closedOffers).toEqual([
        { id: '123-4-3', status: 'REJECTED', resolvedBy: 'RESPONSE', resolvedTick: 124, cancelReason: null },
      ]);
      expect(respondAssignment(outcome.state, 3, '123-4-3', false, 125)).toMatchObject({
        ok: false,
        code: 'OFFER_CLOSED',
      });
      expect(expireAssignments(outcome.state, 30000).state.generals[3]!.dedication).toBe(expected);
    },
  );

  it('남의 제안이나 사라진 제안을 응답할 수 없다', () => {
    const state = deepFreeze(offered());
    expect(respondAssignment(state, 4, '123-4-3', true, 124)).toMatchObject({ ok: false, code: 'OFFER_CLOSED' });
    expect(respondAssignment(state, 3, 'missing', true, 124)).toMatchObject({ ok: false, code: 'OFFER_CLOSED' });
    expect(respondAssignment(state, 999, '123-4-3', true, 124)).toMatchObject({ ok: false, code: 'NO_ACTOR' });
  });

  it.each([null, 0, 1, 'false', {}, []])('boolean이 아닌 응답 %s를 거부한다', (accept) => {
    expect(
      Reflect.apply(respondAssignment, undefined, [deepFreeze(offered()), 3, '123-4-3', accept, 124]),
    ).toMatchObject({ ok: false, code: 'BAD_ARGS' });
  });

  it('응답과 기한 처리가 다른 장수의 제안을 지우지 않는다', () => {
    const state = offered();
    state.generals[7] = { ...state.generals[3]!, id: 7, userId: 'other' };
    const both = applied(assignGeneral(state, 1, 7, 4, 20000)).state;
    const responded = applied(respondAssignment(deepFreeze(both), 3, '123-4-3', true, 20001));
    expect(responded.state.assignmentOffers).toEqual({ 7: both.assignmentOffers![7] });
    const expired = expireAssignments(deepFreeze(both), 30000);
    expect(expired.state.assignmentOffers).toEqual({ 7: both.assignmentOffers![7] });
    expect(expired.closedOffers.map((closed) => closed.id)).toEqual(['123-4-3']);
  });

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('잘못된 tick %s를 받으면 멈춘다', (tick) => {
    const state = deepFreeze(offered());
    expect(() => assignGeneral(state, 4, 3, 1, tick)).toThrow(PersonnelInvariantError);
    expect(() => respondAssignment(state, 3, '123-4-3', true, tick)).toThrow(PersonnelInvariantError);
    expect(() => closeInvalidOffers(state, tick)).toThrow(PersonnelInvariantError);
    expect(() => expireAssignments(state, tick)).toThrow(PersonnelInvariantError);
  });

  it('기한의 정수 범위를 넘는 발령을 만들지 않는다', () => {
    expect(() => assignGeneral(personnelWorld(), 4, 3, 4, Number.MAX_SAFE_INTEGER)).toThrow(PersonnelInvariantError);
  });

  it.each([-1, NaN, Infinity, 9.5])('잘못된 공헌 %s로 거절 비용을 계산하지 않는다', (dedication) => {
    expect(() => assignmentRejectCost(dedication)).toThrow(PersonnelInvariantError);
  });
});

const invalidations: [string, CancelReason, (state: PersonnelState) => void][] = [
  [
    '목표 도시 상실',
    'CITY_LOST',
    (s) => {
      s.cities[4]!.nationId = 2;
    },
  ],
  [
    '목표 도시 소멸',
    'CITY_LOST',
    (s) => {
      delete s.cities[4];
    },
  ],
  [
    '목표 도시 무주',
    'CITY_LOST',
    (s) => {
      s.cities[4]!.nationId = null;
    },
  ],
  [
    '대상 하야',
    'TARGET_LEFT',
    (s) => {
      s.generals[3]!.nationId = null;
      s.generals[3]!.officerLevel = 0;
    },
  ],
  [
    '대상 이적',
    'TARGET_LEFT',
    (s) => {
      s.generals[3]!.nationId = 2;
    },
  ],
  [
    '대상 소멸',
    'TARGET_LEFT',
    (s) => {
      delete s.generals[3];
    },
  ],
  [
    '발령자 해임',
    'ISSUER_LOST_OFFICE',
    (s) => {
      s.generals[4]!.officerLevel = 1;
    },
  ],
  [
    '발령자 하야',
    'ISSUER_LOST_OFFICE',
    (s) => {
      s.generals[4]!.nationId = null;
    },
  ],
  [
    '발령자 이적',
    'ISSUER_LOST_OFFICE',
    (s) => {
      s.generals[4]!.nationId = 2;
    },
  ],
  [
    '발령자 소멸',
    'ISSUER_LOST_OFFICE',
    (s) => {
      delete s.generals[4];
    },
  ],
];

describe('U2 수락 전 자동 취소', () => {
  it.each(invalidations)('%s는 벌점·이동 없이 제안을 닫고 대상 로그 한 줄을 낸다', (_name, reason, prepare) => {
    const state = offered();
    prepare(state);
    const snapshot = structuredClone(state);
    const outcome = closeInvalidOffers(deepFreeze(state), 124);
    expect(outcome.closedOffers).toEqual([
      { id: '123-4-3', status: 'CANCELLED', resolvedBy: null, resolvedTick: 124, cancelReason: reason },
    ]);
    expect(Object.hasOwn(outcome.state, 'assignmentOffers')).toBe(false);
    expect(outcome.state.generals).toEqual(state.generals);
    expect(outcome.logs).toEqual([
      { generalId: 3, commandKey: 'offer.cancel', kind: 'success', text: expect.any(String) },
    ]);
    expect(closeInvalidOffers(outcome.state, 125).logs).toEqual([]);
    expect(state).toEqual(snapshot);
    if (outcome.state.generals[3])
      expect(respondAssignment(outcome.state, 3, '123-4-3', true, 125)).toMatchObject({
        ok: false,
        code: 'OFFER_CLOSED',
      });
  });

  it.each(invalidations.filter(([name]) => name !== '대상 소멸'))(
    '%s를 step 끝에서 놓쳤으면 응답은 불변식 오류로 멈춘다',
    (_name, _reason, prepare) => {
      const state = offered();
      prepare(state);
      expect(() => respondAssignment(deepFreeze(state), 3, '123-4-3', true, 124)).toThrow(PersonnelInvariantError);
      expect(() => respondAssignment(state, 3, '123-4-3', false, 124)).toThrow(PersonnelInvariantError);
    },
  );

  it('유효하지 않은 기존 제안을 닫지 않고 교체하려 하면 멈춘다', () => {
    const state = offered();
    state.generals[4]!.officerLevel = 1;
    expect(() => assignGeneral(deepFreeze(state), 1, 3, 4, 124)).toThrow(PersonnelInvariantError);
  });

  it('사유가 겹치면 도시, 대상, 발령자 순으로 하나만 적는다', () => {
    const state = offered();
    state.cities[4]!.nationId = 2;
    state.generals[3]!.nationId = null;
    state.generals[4]!.officerLevel = 1;
    expect(assignmentCancelReason(state, 3, state.assignmentOffers![3]!)).toBe('CITY_LOST');
    state.cities[4]!.nationId = 1;
    expect(assignmentCancelReason(state, 3, state.assignmentOffers![3]!)).toBe('TARGET_LEFT');
    state.generals[3]!.nationId = 1;
    expect(assignmentCancelReason(state, 3, state.assignmentOffers![3]!)).toBe('ISSUER_LOST_OFFICE');
  });

  it.each([5, 6, 7, 8, 9, 10, 11, 12])('발령자가 권한 직책 %i로 옮겨도 제안은 유효하다', (level) => {
    const state = offered();
    state.generals[4]!.officerLevel = level;
    const outcome = closeInvalidOffers(deepFreeze(state), 124);
    expect(outcome.closedOffers).toEqual([]);
    expect(outcome.state.assignmentOffers).toEqual(state.assignmentOffers);
  });

  it('해임 step에서 닫힌 제안은 재임명 뒤에도 돌아오지 않는다', () => {
    const dismissed = applied(dismissOfficer(offered(), 1, 4));
    const cancelled = closeInvalidOffers(dismissed.state, 124);
    const appointed = applied(appointOfficer(cancelled.state, 1, 4, 5));
    expect(closeInvalidOffers(appointed.state, 125).closedOffers).toEqual([]);
    expect(respondAssignment(appointed.state, 3, '123-4-3', true, 126)).toMatchObject({
      ok: false,
      code: 'OFFER_CLOSED',
    });
  });

  it('도시를 잃었다 되찾아도 취소된 제안을 수락할 수 없다', () => {
    const state = offered();
    state.cities[4]!.nationId = 2;
    const cancelled = closeInvalidOffers(state, 124);
    cancelled.state.cities[4]!.nationId = 1;
    expect(respondAssignment(cancelled.state, 3, '123-4-3', true, 126)).toMatchObject({
      ok: false,
      code: 'OFFER_CLOSED',
    });
  });

  it('국가 멸망은 B1 결정 전까지 U2 취소로 넓히지 않는다', () => {
    const state = offered();
    delete state.nations[1];
    const before = structuredClone(state);
    expect(() => closeInvalidOffers(deepFreeze(state), 124)).toThrow('B1');
    expect(() => expireAssignments(state, 30000)).toThrow('B1');
    expect(() => respondAssignment(state, 3, '123-4-3', true, 124)).toThrow('B1');
    expect(state).toEqual(before);
  });
});

describe('발령 기한', () => {
  it('두 달 기한 직전에는 대기하고 기한에 도달하면 한 번만 이동한다', () => {
    const state = deepFreeze(offered());
    const waiting = expireAssignments(state, 122 + 2 * TICKS_PER_MONTH);
    expect(waiting.state).toEqual(state);
    expect(waiting.logs).toEqual([]);
    const outcome = expireAssignments(deepFreeze(waiting.state), 123 + 2 * TICKS_PER_MONTH);
    expect(outcome.state.generals[3]).toEqual({ ...state.generals[3], cityKey: 4 });
    expect(outcome.closedOffers).toEqual([
      { id: '123-4-3', status: 'ACCEPTED', resolvedBy: 'EXPIRY', resolvedTick: 20123, cancelReason: null },
    ]);
    expect(outcome.logs).toHaveLength(1);
    expect(expireAssignments(outcome.state, 30000).closedOffers).toEqual([]);
    expect(respondAssignment(outcome.state, 3, '123-4-3', true, 30000)).toMatchObject({
      ok: false,
      code: 'OFFER_CLOSED',
    });
  });

  it.each(invalidations)('기한 달의 %s는 기한 수락보다 먼저 취소한다', (_name, reason, prepare) => {
    const state = offered();
    prepare(state);
    const outcome = expireAssignments(deepFreeze(state), 30000);
    expect(outcome.closedOffers).toEqual([
      { id: '123-4-3', status: 'CANCELLED', resolvedBy: null, resolvedTick: 30000, cancelReason: reason },
    ]);
    expect(outcome.state.generals).toEqual(state.generals);
    expect(outcome.logs).toHaveLength(1);
    expect(outcome.logs[0]!.commandKey).toBe('offer.cancel');
  });

  it('같은 tick의 응답과 기한 처리는 먼저 적용한 쪽만 효과가 있다', () => {
    const state = offered();
    const responseFirst = applied(respondAssignment(state, 3, '123-4-3', false, 30000));
    expect(expireAssignments(responseFirst.state, 30000).state.generals[3]).toEqual(responseFirst.state.generals[3]);
    const expiryFirst = expireAssignments(state, 30000);
    expect(respondAssignment(expiryFirst.state, 3, '123-4-3', false, 30000)).toMatchObject({
      ok: false,
      code: 'OFFER_CLOSED',
    });
    expect(expiryFirst.state.generals[3]!.dedication).toBe(95);
  });

  it('유효·취소·만료 제안이 섞여도 종료 ID와 사라진 ID가 같고 정렬이 고정된다', () => {
    let state = personnelWorld();
    for (const id of [10, 7, 8])
      state.generals[id] = { ...state.generals[3]!, id, name: `장수${id}`, userId: `user${id}` };
    state = applied(assignGeneral(state, 4, 10, 4, 100)).state;
    state = applied(assignGeneral(state, 1, 8, 4, 100)).state;
    state = applied(assignGeneral(state, 1, 7, 4, 20000)).state;
    state = applied(assignGeneral(state, 4, 3, 4, 100)).state;
    state.generals[4]!.officerLevel = 1;
    const snapshot = structuredClone(state);
    const outcome = expireAssignments(deepFreeze(state), 30000);
    expect(outcome.closedOffers.map((closed) => [closed.id, closed.status])).toEqual([
      ['100-4-3', 'CANCELLED'],
      ['100-4-10', 'CANCELLED'],
      ['100-1-8', 'ACCEPTED'],
    ]);
    expect(outcome.state.generals[8]!.cityKey).toBe(4);
    expect(Object.keys(outcome.state.assignmentOffers!)).toEqual(['7']);
    const beforeIds = Object.values(state.assignmentOffers!).map((offer) => offer.id);
    const afterIds = new Set(Object.values(outcome.state.assignmentOffers!).map((offer) => offer.id));
    expect(beforeIds.filter((id) => !afterIds.has(id)).sort()).toEqual(
      outcome.closedOffers.map((closed) => closed.id).sort(),
    );
    expect(expireAssignments(snapshot, 30000)).toEqual(outcome);
    expect(state).toEqual(snapshot);
  });
});
