import { describe, expect, it } from 'vitest';
import { applyEffects } from '../commands/effects';
import type { CommandResult } from '../commands/types';
import type { OfficeRevisions } from './offices';
import { assignGeneral } from './assignments';
import { runOfficeAssign, takeOfficeTurn, type OfficeAssignRun, type OfficeSlot } from './officeTurn';
import { applied, deepFreeze, personnelWorld } from './testFixture';
import { PersonnelInvariantError } from './types';

const queue = (): OfficeSlot[] =>
  Array.from({ length: 12 }, (_, i) => ({
    commandKey: 'nation_reward',
    args: { generalId: 3, resource: 'gold', amount: i + 1 },
  }));
function success(run: OfficeAssignRun): CommandResult {
  if ('code' in run.result) throw new Error(run.result.message);
  return run.result;
}

describe('직책 칸 소비', () => {
  it.each([5, 6, 7, 8, 9, 10, 11, 12])('직책 %i의 한 칸만 소비하고 tenure를 보존한다', (level) => {
    const state = personnelWorld();
    state.generals[4]!.officerLevel = level;
    if (level === 12) state.generals[1]!.officerLevel = 1;
    state.officeTurns = { 1: { [level]: queue() } };
    const counters = { 1: { [level]: { revision: 4, tenure: 2 } }, 2: { 12: { revision: 7, tenure: 8 } } };
    const saved = structuredClone({ state, counters });
    const take = takeOfficeTurn(deepFreeze(state), deepFreeze(counters), 4)!;
    expect(take).toEqual({
      nationId: 1,
      officerLevel: level,
      slot: queue()[0],
      queue: [...queue().slice(1), { commandKey: 'nation_rest', args: {} }],
      offices: { 1: { [level]: { revision: 5, tenure: 2 } }, 2: { 12: { revision: 7, tenure: 8 } } },
    });
    expect({ state, counters }).toEqual(saved);
    expect(take.slot).not.toBe(state.officeTurns![1]![level]![0]);
    expect(take.slot.args).not.toBe(state.officeTurns![1]![level]![0]!.args);
    expect(take.queue![0]).not.toBe(state.officeTurns![1]![level]![1]);
    expect(take.offices[2]![12]).not.toBe(counters[2]![12]);
  });

  it('칸과 카운터가 없으면 휴식과 1·0만 돌려주고 상태 키를 만들지 않는다', () => {
    const state = deepFreeze(personnelWorld());
    expect(takeOfficeTurn(state, deepFreeze({}), 4)).toEqual({
      nationId: 1,
      officerLevel: 5,
      slot: { commandKey: 'nation_rest', args: {} },
      queue: null,
      offices: { 1: { 5: { revision: 1, tenure: 0 } } },
    });
    expect(Object.hasOwn(state, 'officeTurns')).toBe(false);
  });

  it('실제 칸이 있고 카운터가 없으면 0·0에서 소비한다', () => {
    const state = personnelWorld();
    state.officeTurns = { 1: { 5: queue() } };
    expect(takeOfficeTurn(deepFreeze(state), {}, 4)!.offices).toEqual({ 1: { 5: { revision: 1, tenure: 0 } } });
  });

  it('칸 인수의 중첩 값과 서로 다른 휴식 인수를 복제한다', () => {
    const state = personnelWorld();
    state.officeTurns = { 1: { 5: queue() } };
    state.officeTurns[1]![5]![1]!.args = { nested: [1, { value: 2 }] };
    const take = takeOfficeTurn(deepFreeze(state), {}, 4)!;
    const args = take.queue![0]!.args as { nested: (number | { value: number })[] };
    (args.nested[1] as { value: number }).value = 9;
    expect(state.officeTurns[1]![5]![1]!.args).toEqual({ nested: [1, { value: 2 }] });
    expect(take.queue![11]!.args).not.toBe(take.slot.args);
  });

  it.each([0, 1, 4])('직책 값 %i의 칸은 소비하지 않는다', (level) => {
    const state = personnelWorld();
    state.generals[4]!.officerLevel = level;
    expect(takeOfficeTurn(deepFreeze(state), deepFreeze({}), 4)).toBeNull();
  });

  it('재야는 직책 칸을 소비하지 않는다', () => {
    const state = personnelWorld();
    state.generals[4]!.nationId = null;
    expect(takeOfficeTurn(deepFreeze(state), {}, 4)).toBeNull();
  });

  it('없는 장수와 국가 없는 직책자는 불변식 오류다', () => {
    const state = personnelWorld();
    expect(() => takeOfficeTurn(deepFreeze(state), {}, 99)).toThrow(PersonnelInvariantError);
    expect(() => takeOfficeTurn(state, {}, 99)).toThrow('장수가 없습니다.');
    const broken = personnelWorld();
    delete broken.nations[1];
    expect(() => takeOfficeTurn(deepFreeze(broken), {}, 4)).toThrow(PersonnelInvariantError);
    expect(() => takeOfficeTurn(broken, {}, 4)).toThrow('직책자가 속한 국가가 없습니다.');
  });

  it.each([
    ['11칸', queue().slice(1)],
    ['13칸', [...queue(), queue()[0]]],
    ['args 없음', [{ commandKey: 'nation_rest' }, ...queue().slice(1)]],
    ['남는 키', [{ commandKey: 'nation_rest', args: {}, extra: 1 }, ...queue().slice(1)]],
    ['문자열 아닌 명령', [{ commandKey: 1, args: {} }, ...queue().slice(1)]],
    ['null 칸', [null, ...queue().slice(1)]],
    ['빈 자리', Array(12)],
    ['null 묶음', null],
  ])('손상된 칸 묶음(%s)을 고쳐 읽지 않는다', (_, broken) => {
    const state = personnelWorld();
    state.officeTurns = { 1: { 5: broken as OfficeSlot[] } };
    const saved = structuredClone(state);
    expect(() => takeOfficeTurn(deepFreeze(state), {}, 4)).toThrow(PersonnelInvariantError);
    expect(state).toEqual(saved);
  });

  it.each([
    { revision: -1, tenure: 0 },
    { revision: 0.5, tenure: 0 },
    { revision: NaN, tenure: 0 },
    { revision: Number.MAX_SAFE_INTEGER, tenure: 0 },
    { revision: 0, tenure: -1 },
    { revision: 0, tenure: Infinity },
    { revision: 0, tenure: 0, extra: 1 },
    { revision: 0 },
    null,
  ])('손상된 카운터 %j를 거부한다', (counter) => {
    const state = deepFreeze(personnelWorld());
    const counters = deepFreeze({ 1: { 5: counter } } as OfficeRevisions);
    const saved = structuredClone(counters);
    expect(() => takeOfficeTurn(state, counters, 4)).toThrow(PersonnelInvariantError);
    expect(counters).toEqual(saved);
  });

  it('안전 정수의 마지막 증가를 정확히 계산한다', () => {
    expect(
      takeOfficeTurn(
        deepFreeze(personnelWorld()),
        { 1: { 5: { revision: Number.MAX_SAFE_INTEGER - 1, tenure: 2 } } },
        4,
      )!.offices[1]![5],
    ).toEqual({ revision: Number.MAX_SAFE_INTEGER, tenure: 2 });
  });
});

describe('직책 칸의 발령 결과', () => {
  it('사람 대상은 이동하지 않고 제안과 대상 로그를 world 효과로 싣는다', () => {
    const state = deepFreeze(personnelWorld());
    const run = runOfficeAssign(state, { generalId: 4 }, { generalId: 3, cityKey: 4 }, 100);
    const next = applyEffects(state as ReturnType<typeof personnelWorld>, success(run).effects);
    expect(next.generals[3]!.cityKey).toBe(1);
    expect(next.assignmentOffers![3]).toEqual({
      id: '100-4-3',
      nationId: 1,
      issuerGeneralId: 4,
      cityKey: 4,
      createdTick: 100,
      expiresTick: 20100,
    });
    expect(run.closedOffers).toEqual([]);
    expect(run.logs).toEqual([
      { generalId: 3, commandKey: 'nation_assign', kind: 'success', text: '도시4 발령 제안이 왔습니다.' },
    ]);
    expect(success(run).logs).toEqual([{ kind: 'success', text: run.logs[0]!.text }]);
    expect(Object.hasOwn(state, 'assignmentOffers')).toBe(false);
  });

  it('NPC 대상은 실제로 이동하고 제안을 만들지 않는다', () => {
    const state = personnelWorld();
    state.generals[3]!.userId = null;
    const run = runOfficeAssign(deepFreeze(state), { generalId: 4 }, { generalId: 3, cityKey: 4 }, 100);
    const next = applyEffects(state, success(run).effects);
    expect(next.generals[3]!.cityKey).toBe(4);
    expect(next.assignmentOffers).toBeUndefined();
    expect(run.logs[0]!.text).toBe('장수3 도시4 발령');
    expect(state.generals[3]!.cityKey).toBe(1);
  });

  it('기존 제안을 SUPERSEDED로 닫고 새 제안과 함께 운반한다', () => {
    const state = applied(assignGeneral(personnelWorld(), 4, 3, 4, 100)).state;
    const run = runOfficeAssign(deepFreeze(state), { generalId: 4 }, { generalId: 3, cityKey: 1 }, 200);
    expect(run.closedOffers).toEqual([
      { id: '100-4-3', status: 'SUPERSEDED', resolvedBy: null, resolvedTick: 200, cancelReason: null },
    ]);
    expect(applyEffects(state, success(run).effects).assignmentOffers![3]!.id).toBe('200-4-3');
    expect(state.assignmentOffers![3]!.id).toBe('100-4-3');
  });

  it.each([
    [{ generalId: 99 }, { generalId: 3, cityKey: 4 }, 'NO_ACTOR'],
    [{ generalId: 4 }, { generalId: 99, cityKey: 4 }, 'BAD_TARGET'],
    [{ generalId: 4 }, { generalId: 3, cityKey: 2 }, 'BAD_TARGET'],
    [{ generalId: 4 }, { generalId: '3', cityKey: 4 }, 'BAD_ARGS'],
    [{ generalId: 4 }, { generalId: 3, cityKey: 4, extra: 1 }, 'BAD_ARGS'],
  ])('실패를 Failure로 남기며 제안·로그를 만들지 않는다 (%j, %j)', (actor, args, code) => {
    const state = deepFreeze(personnelWorld());
    const saved = structuredClone(state);
    expect(runOfficeAssign(state, actor, args, 100)).toMatchObject({ result: { code }, closedOffers: [], logs: [] });
    expect(state).toEqual(saved);
  });

  it('재야 발령자는 NOT_NATION이고 권한 없는 장수는 불변식 오류다', () => {
    const state = personnelWorld();
    state.generals[4]!.nationId = null;
    expect(
      runOfficeAssign(deepFreeze(state), { generalId: 4 }, { generalId: 3, cityKey: 4 }, 100).result,
    ).toMatchObject({ code: 'NOT_NATION' });
    const denied = personnelWorld();
    denied.generals[4]!.officerLevel = 1;
    expect(() => runOfficeAssign(deepFreeze(denied), { generalId: 4 }, { generalId: 3, cityKey: 4 }, 100)).toThrow(
      PersonnelInvariantError,
    );
  });

  it('같은 tick의 ID 충돌과 유효하지 않은 이전 제안을 숨기지 않는다', () => {
    const pending = applied(assignGeneral(personnelWorld(), 4, 3, 4, 100)).state;
    expect(() => runOfficeAssign(deepFreeze(pending), { generalId: 4 }, { generalId: 3, cityKey: 4 }, 100)).toThrow(
      PersonnelInvariantError,
    );
    const invalid = structuredClone(pending);
    invalid.cities[4]!.nationId = 2;
    expect(() => runOfficeAssign(deepFreeze(invalid), { generalId: 4 }, { generalId: 3, cityKey: 1 }, 200)).toThrow(
      PersonnelInvariantError,
    );
  });
});
