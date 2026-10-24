import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { settleTreaties } from '../diplomacy/treaty';
import { buildYearbook, monthlyDate, runMonthly } from '../monthly/index';
import { removeNation } from '../commands/support';
import { assignGeneral } from './assignments';
import { expirePersonnelMonth } from './month';
import { completePersonnelStep } from './step';
import { applied, deepFreeze, personnelWorld } from './testFixture';

function pending() {
  return applied(assignGeneral(personnelWorld(), 4, 3, 4, 0)).state;
}

describe('월간 인사의 raw 만료 앞부분', () => {
  it('정확한 기한에 수락하고 카운터를 복제하되 완료 packet을 만들지 않는다', () => {
    const settled = pending();
    const offices = { 1: { 5: { revision: 4, tenure: 2 } } };
    const saved = structuredClone({ settled, offices });
    const raw = expirePersonnelMonth(deepFreeze(settled), deepFreeze(offices), 20000);
    expect(raw.state.generals[3]!.cityKey).toBe(4);
    expect(raw.state.assignmentOffers).toBeUndefined();
    expect(raw.closedOffers).toEqual([
      { id: '0-4-3', status: 'ACCEPTED', resolvedBy: 'EXPIRY', resolvedTick: 20000, cancelReason: null },
    ]);
    expect(raw.logs.map((log) => log.commandKey)).toEqual(['offer.expire']);
    expect(raw.offices).toEqual(offices);
    expect(raw.offices).not.toBe(offices);
    expect(raw.offices[1]![5]).not.toBe(offices[1]![5]);
    expect(Object.keys(raw).sort()).toEqual(['closedOffers', 'logs', 'offices', 'state']);
    for (const key of ['beforeFinish', 'final', 'packet']) expect(Object.hasOwn(raw, key)).toBe(false);
    expect({ settled, offices }).toEqual(saved);
  });

  it('기한 달의 도시 상실은 수락 전에 U2로 취소한다', () => {
    const settled = pending();
    settled.cities[4]!.nationId = 2;
    const raw = expirePersonnelMonth(deepFreeze(settled), {}, 20000);
    expect(raw.state.generals[3]!.cityKey).toBe(1);
    expect(raw.closedOffers).toEqual([
      { id: '0-4-3', status: 'CANCELLED', resolvedBy: null, resolvedTick: 20000, cancelReason: 'CITY_LOST' },
    ]);
    expect(raw.logs.map((log) => log.commandKey)).toEqual(['offer.cancel']);
  });

  it('기한 전 제안을 남기고 빈 직책 선택 키를 만들지 않는다', () => {
    const settled = deepFreeze(pending());
    const raw = expirePersonnelMonth(settled, deepFreeze({}), 10000);
    expect(raw.state.assignmentOffers).toEqual(settled.assignmentOffers);
    expect(raw.closedOffers).toEqual([]);
    expect(raw.logs).toEqual([]);
    expect(raw.offices).toEqual({});
    expect(Object.hasOwn(raw.state, 'officeTurns')).toBe(false);
    expect(Object.hasOwn(raw.state, 'offices')).toBe(false);
  });

  it('U2 취소 로그 뒤에 기한 수락 로그를 싣는다', () => {
    const state = personnelWorld();
    state.generals[5] = { ...state.generals[3]!, id: 5, userId: 'target5' };
    const first = applied(assignGeneral(state, 4, 3, 4, 0));
    const settled = applied(assignGeneral(first.state, 4, 5, 1, 0)).state;
    settled.cities[4]!.nationId = 2;
    const raw = expirePersonnelMonth(deepFreeze(settled), {}, 20000);
    expect(raw.closedOffers.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: '0-4-3', status: 'CANCELLED' },
      { id: '0-4-5', status: 'ACCEPTED' },
    ]);
    expect(raw.logs.map(({ generalId, commandKey }) => ({ generalId, commandKey }))).toEqual([
      { generalId: 3, commandKey: 'offer.cancel' },
      { generalId: 5, commandKey: 'offer.expire' },
    ]);
    expect(new Set(raw.closedOffers.map((offer) => offer.id)).size).toBe(2);
  });

  it('멸망한 국가의 PENDING을 B1 오류로 남긴다', () => {
    const settled = pending();
    removeNation(settled, 1);
    const saved = structuredClone(settled);
    expect(() => expirePersonnelMonth(deepFreeze(settled), {}, 20000)).toThrow(
      '국가 멸망 시 발령 처리는 B1 결정이 필요합니다.',
    );
    expect(settled).toEqual(saved);
  });

  it.each([undefined, 0, -10000, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 10001])(
    '월 경계가 아닌 tick 값(%s)을 거부한다',
    (tick) => {
      const settled = deepFreeze(pending());
      expect(() => expirePersonnelMonth(settled, {}, tick as number)).toThrow('월 경계 tick이 필요합니다.');
      expect(settled.assignmentOffers![3]!.id).toBe('0-4-3');
    },
  );

  it('시험 안에서만 실제 월간·조약 정산 뒤 마무리와 연결해 yearbook을 대조한다', () => {
    const before = pending();
    const settled = settleTreaties(runMonthly(before, 20000, rngFor('p3-month')).state, 20000);
    const raw = expirePersonnelMonth(deepFreeze(settled), {}, 20000);
    const packet = completePersonnelStep(deepFreeze(before), {}, deepFreeze(raw), 20000);
    const year = monthlyDate(before.startYear, 20000).year;
    expect(packet.state.generals[3]!.cityKey).toBe(4);
    expect(buildYearbook(packet.state, year)).toEqual(buildYearbook(settled, year));
    expect(packet.assignment.before.assignmentOffers![3]!.id).toBe('0-4-3');
    expect(packet.assignment.beforeFinish).toEqual({});
    expect(packet.assignment.final).toEqual({});
    expect(packet.assignment.closedOffers).toEqual(raw.closedOffers);
    expect(packet.offices).toEqual({});
  });

  it('빈 상태의 raw 결과와 카운터도 입력에서 분리한다', () => {
    const state = deepFreeze(personnelWorld());
    const raw = expirePersonnelMonth(state, deepFreeze({}), 10000);
    expect(raw.state).not.toBe(state);
    expect(raw.closedOffers).toEqual([]);
    expect(raw.logs).toEqual([]);
    expect(Object.hasOwn(raw.state, 'assignmentOffers')).toBe(false);
    expect(raw.state.generals[3]).not.toBe(state.generals[3]);
    expect(raw.offices).toEqual({});
  });
});
