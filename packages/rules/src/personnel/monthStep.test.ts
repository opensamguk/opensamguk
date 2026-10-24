import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { removeNation } from '../commands/support';
import { buildYearbook, runMonthly } from '../monthly/index';
import { dismissOfficer } from './appointments';
import { assignGeneral } from './assignments';
import { runPersonnelMonth, type PersonnelMonthInput } from './monthStep';
import { applied, deepFreeze, personnelWorld } from './testFixture';
import { PersonnelInvariantError } from './types';

function world() {
  const state = personnelWorld();
  state.nations[1]!.gold = 0;
  state.nations[2]!.gold = 0;
  state.cities[1]!.connections = [4];
  state.cities[4]!.connections = [1, 2];
  return state;
}

function input(tick = 70_000): PersonnelMonthInput {
  const before = world();
  return { before, settled: structuredClone(before), anchors: { 3: 0, 4: 0 }, startOffices: {}, tick };
}

describe('월간 인사의 만료·NPC·마무리 조합', () => {
  it('실제 NPC leaf가 제안을 만들고 B·W·F와 앵커를 보존한다', () => {
    const step = input();
    const result = runPersonnelMonth(step);
    expect(result.packet.assignment.before).toEqual({});
    expect(result.packet.assignment.beforeFinish.assignmentOffers![3]!.id).toBe('70000-1-3');
    expect(result.packet.assignment.final).toEqual(result.packet.assignment.beforeFinish);
    expect(result.packet.assignment.closedOffers).toEqual([]);
    expect(result.packet.logs.map((log) => log.commandKey)).toEqual(['nation_assign']);
    expect(result.packet.state.generals[3]!.cityKey).toBe(1);
    expect(result.anchors).toEqual({ 3: 0, 4: 0 });
    expect(result.history).toHaveLength(1);
  });

  it('P3 기한 수락으로 도착한 사람은 같은 달 재발령하지 않고 앵커를 갱신한다', () => {
    const state = world();
    state.generals[4]!.userId = null;
    const before = applied(assignGeneral(state, 1, 3, 4, 50_000)).state;
    const result = runPersonnelMonth({ before, settled: before, anchors: { 3: 0 }, startOffices: {}, tick: 70_000 });
    expect(result.packet.assignment.before.assignmentOffers![3]!.id).toBe('50000-1-3');
    expect(result.packet.assignment.beforeFinish).toEqual({});
    expect(result.packet.assignment.final).toEqual({});
    expect(result.packet.assignment.closedOffers).toMatchObject([
      { id: '50000-1-3', status: 'ACCEPTED', resolvedBy: 'EXPIRY', resolvedTick: 70_000 },
    ]);
    expect(result.packet.state.generals[3]!.cityKey).toBe(4);
    expect(result.packet.logs.map((log) => log.commandKey)).toEqual(['offer.expire']);
    expect(result.anchors).toEqual({ 3: 70_000 });
    expect(result.history).toEqual([]);
  });

  it('같은 도시 기한 수락은 앵커를 보존하고 새 제안 하나만 만든다', () => {
    const state = world();
    state.generals[4]!.userId = null;
    const before = applied(assignGeneral(state, 1, 3, 1, 50_000)).state;
    const result = runPersonnelMonth({ before, settled: before, anchors: { 3: 0 }, startOffices: {}, tick: 70_000 });
    expect(result.packet.assignment.closedOffers).toMatchObject([{ id: '50000-1-3', status: 'ACCEPTED' }]);
    expect(result.packet.assignment.beforeFinish.assignmentOffers![3]!.id).toBe('70000-1-3');
    expect(result.packet.assignment.final).toEqual(result.packet.assignment.beforeFinish);
    expect(result.packet.logs.map((log) => log.commandKey)).toEqual(['offer.expire', 'nation_assign']);
    expect(result.anchors).toEqual({ 3: 0 });
  });

  it('직책 상실의 취소는 만료보다 먼저이며 직책 카운터는 마무리 한 번만 반영한다', () => {
    const before = applied(assignGeneral(world(), 4, 3, 4, 50_000)).state;
    before.officeTurns = { 1: { 5: Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })) } };
    const settled = applied(dismissOfficer(before, 1, 4)).state;
    const startOffices = { 1: { 5: { revision: 7, tenure: 2 } } };
    const result = runPersonnelMonth({ before, settled, anchors: { 3: 0, 4: 0 }, startOffices, tick: 70_000 });
    expect(result.packet.assignment.closedOffers).toMatchObject([
      { id: '50000-4-3', status: 'CANCELLED', cancelReason: 'ISSUER_LOST_OFFICE' },
    ]);
    expect(result.packet.assignment.beforeFinish.assignmentOffers![3]!.id).toBe('70000-1-3');
    expect(result.packet.assignment.final).toEqual(result.packet.assignment.beforeFinish);
    expect(result.packet.offices).toEqual({ 1: { 5: { revision: 8, tenure: 3 } } });
    expect(result.packet.logs.map((log) => log.commandKey)).toEqual(['offer.cancel', 'nation_assign']);
    expect(result.anchors).toEqual({ 3: 0, 4: 0 });
  });

  it('국가 멸망 취소를 한 번 전달하고 물리 도착 시각은 바꾸지 않는다', () => {
    const before = applied(assignGeneral(world(), 1, 3, 4, 50_000)).state;
    const settled = structuredClone(before);
    removeNation(settled, 1);
    const result = runPersonnelMonth({
      before,
      settled,
      anchors: { 3: 0, 4: 0 },
      startOffices: { 1: { 5: { revision: 7, tenure: 2 } } },
      tick: 70_000,
    });
    expect(result.packet.assignment.closedOffers).toMatchObject([
      { id: '50000-1-3', status: 'CANCELLED', cancelReason: 'NATION_DESTROYED' },
    ]);
    expect(result.packet.assignment.closedOffers).toHaveLength(1);
    expect(result.packet.logs.map((log) => log.commandKey)).toEqual(['offer.cancel']);
    expect(result.packet.offices).toEqual({});
    expect(result.anchors).toEqual({ 3: 0, 4: 0 });
    expect(result.history).toEqual([]);
  });

  it('NPC 주기 밖에도 P3 이동과 앵커 갱신을 수행한다', () => {
    const before = applied(assignGeneral(world(), 1, 3, 4, 0)).state;
    const result = runPersonnelMonth({
      before,
      settled: before,
      anchors: { 3: 0, 4: 0 },
      startOffices: {},
      tick: 20_000,
    });
    expect(result.packet.state.generals[3]!.cityKey).toBe(4);
    expect(result.anchors).toEqual({ 3: 20_000, 4: 0 });
    expect(result.packet.logs.map((log) => log.commandKey)).toEqual(['offer.expire']);
    expect(result.history).toEqual([]);
  });

  it('이미 정산한 금을 다시 더하지 않고 연감은 NPC 포상 뒤 F를 따라야 한다', () => {
    const before = world();
    before.nations[1]!.gold = 10_000;
    before.generals[5] = { ...before.generals[3]!, id: 5, userId: 'person5', name: '장수5' };
    const monthly = runMonthly(before, 40_000, rngFor('month-step', 'monthly', before.startYear, 4));
    const result = runPersonnelMonth({
      before,
      settled: monthly.state,
      anchors: { 3: 0, 4: 0, 5: 0 },
      startOffices: {},
      tick: 40_000,
    });
    const yearbook = buildYearbook(result.packet.state, monthly.date.year);
    const oldNation = monthly.yearbook.nations.find((nation) => nation.nationId === 1)!;
    const finalNation = yearbook.nations.find((nation) => nation.nationId === 1)!;
    expect(finalNation.gold).toBe(oldNation.gold - 3_000);
    expect(result.packet.state.nations[1]!.gold).toBe(finalNation.gold);
    expect(result.packet.state.nations[1]!.rice).toBe(monthly.state.nations[1]!.rice);
    expect(yearbook).not.toEqual(monthly.yearbook);
    expect(result.history).toHaveLength(3);
  });

  it('빠진 사람 장수의 앵커를 0으로 보정하지 않는다', () => {
    const step = input(20_000);
    expect(() => runPersonnelMonth({ ...step, anchors: {} })).toThrow(PersonnelInvariantError);
  });

  it.each([0, -10_000, 10_001, NaN])('월 경계가 아닌 tick은 거부한다 (%s)', (tick) => {
    expect(() => runPersonnelMonth(input(tick))).toThrow();
  });

  it('입력 불변·동일 결과와 비어 있는 선택 키 생략을 보존한다', () => {
    const step = input(20_000);
    const saved = structuredClone(step);
    deepFreeze(step);
    const result = runPersonnelMonth(step);
    expect(runPersonnelMonth(step)).toEqual(result);
    expect(step).toEqual(saved);
    expect(result.packet.offices).toEqual({});
    expect(result.packet.offices).not.toBe(step.startOffices);
    expect(Object.hasOwn(result.packet.state, 'assignmentOffers')).toBe(false);
    expect(Object.hasOwn(result.packet.state, 'officeTurns')).toBe(false);
    expect(Object.hasOwn(result.packet.state, 'offices')).toBe(false);
    expect(result.anchors).not.toBe(step.anchors);
    expect(result.history).toEqual([]);
  });
});
