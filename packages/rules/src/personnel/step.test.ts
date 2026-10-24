import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { applyEffects } from '../commands/effects';
import { runCommand } from '../commands/registry';
import { removeNation } from '../commands/support';
import { applyTreatyInput } from '../diplomacy/treaty';
import { buildCreatedGeneral } from '../general/create';
import { testUnits } from '../../test/commandFixture';
import type { OfficeRevisions, OfficeView } from './offices';
import { dismissOfficer } from './appointments';
import { assignGeneral, respondAssignment } from './assignments';
import { completePersonnelStep, type PersonnelRawStep } from './step';
import { applied, deepFreeze, personnelWorld } from './testFixture';
import { PersonnelInvariantError } from './types';

function unchanged(state: OfficeView, offices: OfficeRevisions = {}): PersonnelRawStep {
  return { state, offices, closedOffers: [], logs: [] };
}

describe('인사 step의 저장 묶음', () => {
  it('같은 step에서 생겼다가 해임으로 취소된 제안의 W와 종료 로그를 보존한다', () => {
    const before = personnelWorld();
    const assigned = applied(assignGeneral(before, 4, 3, 4, 100));
    const dismissed = applied(dismissOfficer(assigned.state, 1, 4));
    const raw = {
      state: dismissed.state,
      offices: {},
      closedOffers: [...assigned.closedOffers, ...dismissed.closedOffers],
      logs: [...assigned.logs, ...dismissed.logs],
    };
    const saved = structuredClone({ before, raw });
    const packet = completePersonnelStep(deepFreeze(before), deepFreeze({}), deepFreeze(raw), 100);
    expect(packet.assignment.before).toEqual({});
    expect(packet.assignment.beforeFinish).toEqual({ assignmentOffers: assigned.state.assignmentOffers });
    expect(packet.assignment.final).toEqual({});
    expect(packet.assignment.closedOffers).toEqual([
      { id: '100-4-3', status: 'CANCELLED', resolvedBy: null, resolvedTick: 100, cancelReason: 'ISSUER_LOST_OFFICE' },
    ]);
    expect(packet.logs.map((log) => log.commandKey)).toEqual(['nation_assign', 'personnel.dismiss', 'offer.cancel']);
    expect(packet.logs.every((log) => !Object.hasOwn(log, 'sequence') && !Object.hasOwn(log, 'ordinal'))).toBe(true);
    expect(packet.state.assignmentOffers).toBeUndefined();
    expect(packet.offices).toEqual({ 1: { 5: { revision: 1, tenure: 1 } } });
    expect({ before, raw }).toEqual(saved);
    expect(packet.assignment.beforeFinish.assignmentOffers).not.toBe(raw.state.assignmentOffers);
    expect(packet.logs[0]).not.toBe(raw.logs[0]);
  });

  it('B의 교체 종료와 W의 새 제안 취소를 빠짐없이 전달한다', () => {
    const before = applied(assignGeneral(personnelWorld(), 4, 3, 4, 100)).state;
    const replacement = applied(assignGeneral(before, 4, 3, 1, 200));
    const dismissed = applied(dismissOfficer(replacement.state, 1, 4));
    const raw = {
      state: dismissed.state,
      offices: {},
      closedOffers: [...replacement.closedOffers, ...dismissed.closedOffers],
      logs: [...replacement.logs, ...dismissed.logs],
    };
    const packet = completePersonnelStep(deepFreeze(before), {}, deepFreeze(raw), 200);
    expect(packet.assignment.before.assignmentOffers![3]!.id).toBe('100-4-3');
    expect(packet.assignment.beforeFinish.assignmentOffers![3]!.id).toBe('200-4-3');
    expect(packet.assignment.closedOffers.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: '100-4-3', status: 'SUPERSEDED' },
      { id: '200-4-3', status: 'CANCELLED' },
    ]);
    expect(packet.assignment.final).toEqual({});
  });

  it('실제 응답 수락의 도시 이동과 종료를 보존한다', () => {
    const before = applied(assignGeneral(personnelWorld(), 4, 3, 4, 100)).state;
    const response = applied(respondAssignment(before, 3, '100-4-3', true, 200));
    const packet = completePersonnelStep(deepFreeze(before), {}, deepFreeze({ ...response, offices: {} }), 200);
    expect(packet.state.generals[3]!.cityKey).toBe(4);
    expect(packet.assignment.beforeFinish).toEqual({});
    expect(packet.assignment.closedOffers).toEqual([
      { id: '100-4-3', status: 'ACCEPTED', resolvedBy: 'RESPONSE', resolvedTick: 200, cancelReason: null },
    ]);
    expect(packet.logs.map((log) => log.commandKey)).toEqual(['offer.respond']);
  });

  it('칸 소비 뒤 실제 하야를 마무리하면 revision +2와 tenure +1을 한 번 싣는다', () => {
    const before = personnelWorld();
    before.officeTurns = {
      1: {
        5: Array.from({ length: 12 }, () => ({
          commandKey: 'nation_reward',
          args: { generalId: 3, resource: 'gold', amount: 1 },
        })),
      },
    };
    const start = { 1: { 5: { revision: 4, tenure: 2 } } };
    const result = runCommand(before, { generalId: 4, tick: 100 }, 'resign', {}, rngFor('p2-resign'));
    if ('code' in result) throw new Error(result.message);
    const raw = unchanged(applyEffects(before, result.effects), { 1: { 5: { revision: 5, tenure: 2 } } });
    const packet = completePersonnelStep(deepFreeze(before), deepFreeze(start), deepFreeze(raw), 100);
    expect(packet.offices).toEqual({ 1: { 5: { revision: 6, tenure: 3 } } });
    expect(packet.office.before.offices).toEqual(start);
    expect(packet.office.before.officeTurns).toEqual(before.officeTurns);
    expect(packet.office.next.offices).toEqual(packet.offices);
    expect(packet.office.next.officeTurns![1]![5]).toEqual(
      Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })),
    );
    expect(packet.office.next.officeTurns![1]![5]![0]!.args).not.toBe(packet.office.next.officeTurns![1]![5]![1]!.args);
    expect(packet.office.before.offices[1]![5]).not.toBe(start[1]![5]);
    expect(packet.state.generals[4]).toMatchObject({ nationId: null, officerLevel: 0 });
  });

  it('국가 멸망 제안의 B·W·F와 취소 기록을 남기고 입력을 보존한다', () => {
    const before = applied(assignGeneral(personnelWorld(), 4, 3, 4, 100)).state;
    const state = structuredClone(before);
    removeNation(state, 1);
    const raw = unchanged(state);
    const saved = structuredClone({ before, raw });
    const packet = completePersonnelStep(deepFreeze(before), {}, deepFreeze(raw), 200);
    expect(packet.assignment.before).toEqual({ assignmentOffers: before.assignmentOffers });
    expect(packet.assignment.beforeFinish).toEqual({ assignmentOffers: raw.state.assignmentOffers });
    expect(packet.assignment.final).toEqual({});
    expect(packet.assignment.closedOffers).toEqual([
      { id: '100-4-3', status: 'CANCELLED', resolvedBy: null, resolvedTick: 200, cancelReason: 'NATION_DESTROYED' },
    ]);
    expect(packet.state.generals).toEqual(raw.state.generals);
    expect(packet.logs.map(({ commandKey }) => commandKey)).toEqual(['offer.cancel']);
    expect({ before, raw }).toEqual(saved);
  });

  it('빈 선택 키를 만들지 않고 ext·조약·개인 시각과 입력을 보존한다', () => {
    const before = personnelWorld();
    before.ext = { module: { values: [1, 2] } };
    before.treaties = [];
    const saved = structuredClone(before);
    const packet = completePersonnelStep(deepFreeze(before), deepFreeze({}), deepFreeze(unchanged(before)), 0);
    expect(packet.state).toEqual(saved);
    for (const view of [
      packet.state,
      packet.assignment.before,
      packet.assignment.beforeFinish,
      packet.assignment.final,
    ])
      expect(Object.hasOwn(view, 'assignmentOffers')).toBe(false);
    for (const view of [packet.state, packet.office.before, packet.office.next])
      expect(Object.hasOwn(view, 'officeTurns')).toBe(false);
    expect(Object.hasOwn(packet.state, 'offices')).toBe(false);
    expect(before).toEqual(saved);
    packet.state.ext!.module = { values: [9] };
    expect(before.ext).toEqual(saved.ext);
  });

  it.each([undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '잘못된 tick 값(%s)을 보완하지 않고 거부한다',
    (tick) => {
      const before = deepFreeze(personnelWorld());
      const raw = deepFreeze(unchanged(before));
      const saved = structuredClone({ before, raw });
      expect(() => completePersonnelStep(before, {}, raw, tick as number)).toThrow(PersonnelInvariantError);
      expect({ before, raw }).toEqual(saved);
    },
  );

  it('실제 조약 제안 뒤에도 마무리 packet을 만들고 직책 카운터를 더 올리지 않는다', () => {
    const before = personnelWorld();
    before.nations[2]!.isNpc = false;
    const result = applyTreatyInput(
      deepFreeze(before),
      { generalId: 1, kind: 'treaty.propose', payload: { toNationId: 2, clauses: [{ kind: 'peace' }] } },
      { tick: 100, sequence: 1 },
    );
    if (!result.ok) throw new Error(result.result.message);
    const start = deepFreeze({ 1: { 5: { revision: 4, tenure: 2 } } });
    const packet = completePersonnelStep(deepFreeze(before), start, deepFreeze(unchanged(result.state, start)), 100);
    expect(packet.state.treaties).toEqual(result.state.treaties);
    expect(packet.state.treaties).toHaveLength(1);
    expect(packet.offices).toEqual(start);
    expect(packet.office.before).toEqual(packet.office.next);
    expect(packet.assignment.closedOffers).toEqual([]);
    expect(packet.logs).toEqual([]);
  });

  it('실제 재야 장수 생성 결과를 마무리하고 기존 직책 카운터를 보존한다', () => {
    const before = personnelWorld();
    const created = buildCreatedGeneral({
      payload: { name: '신규', leadership: 70, strength: 70, intel: 60, portraitId: null },
      seed: 'p2-create',
      userId: 'new-user',
      id: 5,
      startYear: before.startYear,
      monthlyTick: 0,
      tick: 100,
      cityKeys: [1, 2, 3, 4],
      unitSet: testUnits,
    });
    const state = structuredClone(before);
    state.generals[5] = created;
    const start = deepFreeze({ 1: { 5: { revision: 4, tenure: 2 } } });
    const packet = completePersonnelStep(deepFreeze(before), start, deepFreeze(unchanged(state, start)), 100);
    expect(packet.state.generals[5]).toEqual(created);
    expect(packet.offices).toEqual(start);
    expect(packet.office.before).toEqual(packet.office.next);
    expect(packet.assignment.closedOffers).toEqual([]);
    expect(packet.logs).toEqual([]);
  });

  it('B와 W의 제안 및 office 스냅샷은 이후 결과 변경과 분리된다', () => {
    const before = applied(assignGeneral(personnelWorld(), 4, 3, 4, 100)).state;
    const start = { 1: { 5: { revision: 4, tenure: 2 } } };
    const packet = completePersonnelStep(
      deepFreeze(before),
      deepFreeze(start),
      deepFreeze(unchanged(before, start)),
      200,
    );
    packet.state.assignmentOffers![3]!.cityKey = 1;
    packet.offices[1]![5]!.revision = 99;
    expect(packet.assignment.before.assignmentOffers![3]!.cityKey).toBe(4);
    expect(packet.assignment.beforeFinish.assignmentOffers![3]!.cityKey).toBe(4);
    expect(packet.assignment.final.assignmentOffers![3]!.cityKey).toBe(4);
    expect(packet.office.next.offices[1]![5]!.revision).toBe(4);
    expect(start[1]![5]!.revision).toBe(4);
  });
});
