import { describe, expect, it } from 'vitest';
import { removeNation } from '../commands/support';
import { assignGeneral } from './assignments';
import {
  applyNationTurnsRecord,
  applyPersonnelInput,
  finishPersonnelStep,
  replayPersonnelInput,
  validatePersonnelRecord,
  type PendingPersonnelEvent,
  type NationTurnsRecord,
} from './inputs';
import { applied, deepFreeze, personnelWorld } from './testFixture';
import type { OfficeState } from './offices';

const requestId = '10000000-0000-4000-8000-000000000001';
const context = { tick: 200, worldStatus: 'RUNNING', userActive: true } as const;
function world(): OfficeState {
  const state = personnelWorld();
  state.generals[1]!.userId = 'ruler';
  return state;
}
function event(change: Partial<PendingPersonnelEvent> = {}): PendingPersonnelEvent {
  return {
    kind: 'personnel.appoint',
    userId: 'ruler',
    generalId: 1,
    idempotencyKey: `personnel:${requestId}`,
    payload: { generalId: 3, officerLevel: 11 },
    ...change,
  };
}
function appoint() {
  const before = world();
  const result = applyPersonnelInput(deepFreeze(before), event(), context);
  if (result.status !== 'APPLIED') throw new Error('임명 실패');
  return { before, result };
}
function turnRecord(): NationTurnsRecord {
  const record = validatePersonnelRecord(
    {
      sequence: 1,
      generalId: 4,
      kind: 'nationTurns.set',
      status: 'APPLIED',
      payload: {
        office: { nationId: 1, officerLevel: 5, tenure: 0 },
        revision: 0,
        turns: Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })),
      },
      result: { revision: 1 },
    },
    { monthlyTick: 0 },
  );
  if (record.kind !== 'nationTurns.set') throw new Error('기록 종류');
  return record;
}

describe('선택된 인사 입력', () => {
  it.each([0, -1])('없는 대상 %i는 구조 오류가 아닌 BAD_TARGET으로 기록한다', (generalId) => {
    for (const kind of ['personnel.appoint', 'personnel.dismiss'] as const) {
      const payload = kind === 'personnel.appoint' ? { generalId, officerLevel: 11 } : { generalId };
      const outcome = applyPersonnelInput(deepFreeze(world()), event({ kind, payload }), context);
      expect(outcome).toMatchObject({ status: 'REJECTED', result: { code: 'BAD_TARGET' } });
      expect(
        validatePersonnelRecord(
          { sequence: 1, generalId: 1, kind, status: outcome.status, payload, result: outcome.result },
          { monthlyTick: 0 },
        ),
      ).toMatchObject({ status: 'REJECTED', result: { code: 'BAD_TARGET' } });
    }
  });
  it('동결 상태를 임명하고 같은 함수로 재생하며 다른 상태 키를 보존한다', () => {
    const before = world();
    before.ext = { module: { values: [1, 2] } };
    before.treaties = [];
    before.officeTurns = {
      1: { 11: [{ commandKey: 'nation_reward', args: { generalId: 3, resource: 'gold', amount: 1 } }] },
    };
    const saved = structuredClone(before);
    const outcome = applyPersonnelInput(deepFreeze(before), event(), context);
    expect(before).toEqual(saved);
    if (outcome.status !== 'APPLIED') throw new Error('임명 실패');
    expect(outcome.result).toEqual({ generalId: 3, officerLevel: 11, title: '참모', tick: 200 });
    const record = validatePersonnelRecord(
      {
        sequence: 2,
        generalId: 1,
        kind: 'personnel.appoint',
        status: 'APPLIED',
        payload: event().payload,
        result: outcome.result,
      },
      { monthlyTick: 100 },
    );
    if (record.kind !== 'personnel.appoint' || record.status !== 'APPLIED') throw new Error('기록 종류');
    expect(replayPersonnelInput(before, record)).toEqual(outcome.change);
    const finish = finishPersonnelStep(before, outcome.change, { 1: { 11: { revision: 7, tenure: 2 } } }, 200);
    expect(finish.state.officeTurns?.[1]?.[11]).toEqual(
      Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })),
    );
    expect(finish.offices[1]?.[11]).toEqual({ revision: 8, tenure: 3 });
    expect(finish.state.ext).toEqual(saved.ext);
    expect(finish.state.treaties).toEqual([]);
  });
  it.each(['PREOPEN', 'PAUSED', 'ENDED'] as const)('%s에서는 상태를 바꾸지 않는다', (worldStatus) => {
    const state = deepFreeze(world());
    expect(applyPersonnelInput(state, event(), { ...context, worldStatus })).toMatchObject({
      status: 'REJECTED',
      result: { code: 'WORLD_CLOSED' },
    });
    expect(state.generals[3]!.officerLevel).toBe(1);
  });
  it('비활성 계정과 다른 사용자 행위자를 거절한다', () => {
    expect(applyPersonnelInput(world(), event(), { ...context, userActive: false })).toMatchObject({
      result: { code: 'ACTOR_INACTIVE' },
    });
    expect(applyPersonnelInput(world(), event({ userId: 'other' }), context)).toMatchObject({
      result: { code: 'NO_GENERAL' },
    });
    expect(applyPersonnelInput(world(), event({ generalId: 999 }), context)).toMatchObject({
      result: { code: 'NO_GENERAL' },
    });
  });
  it.each([
    { kind: 'general.create' },
    { idempotencyKey: 'personnel:no-uuid' },
    { generalId: null },
    { generalId: 1.5 },
    { payload: { generalId: 3, officerLevel: 11, extra: 0 } },
    { kind: 'offer.respond', payload: { offerId: 'x', accept: 'true' } },
  ])('손상된 입력은 월드 거절보다 먼저 throw한다: %j', (change) => {
    expect(() =>
      applyPersonnelInput(deepFreeze(world()), event(change), { ...context, worldStatus: 'ENDED' }),
    ).toThrow();
  });
  it.each([-1, 0.5, NaN])('잘못된 tick %s를 거부한다', (tick) => {
    expect(() => applyPersonnelInput(world(), event(), { ...context, tick })).toThrow();
  });
  it.each([
    [{ generalId: 3, officerLevel: 12 }, 'BAD_ARGS'],
    [{ generalId: 3, officerLevel: 5 }, 'BAD_STATE'],
    [{ generalId: 2, officerLevel: 11 }, 'BAD_TARGET'],
  ])('순수 인사 규칙의 거절을 유지한다: %j', (payload, code) => {
    expect(applyPersonnelInput(world(), event({ payload }), context)).toMatchObject({
      status: 'REJECTED',
      result: { code },
    });
  });
  it('해임이 발령자 권한 상실 취소를 일으키고 공헌을 깎지 않는다', () => {
    const state = applied(assignGeneral(world(), 4, 3, 4, 123)).state;
    const outcome = applyPersonnelInput(
      deepFreeze(state),
      event({ kind: 'personnel.dismiss', payload: { generalId: 4 } }),
      context,
    );
    if (outcome.status !== 'APPLIED') throw new Error('해임 실패');
    const finished = finishPersonnelStep(state, outcome.change, {}, 200);
    expect(finished.closedOffers).toEqual([
      { id: '123-4-3', status: 'CANCELLED', resolvedBy: null, cancelReason: 'ISSUER_LOST_OFFICE', resolvedTick: 200 },
    ]);
    expect(finished.state.generals[3]!.dedication).toBe(95);
    expect(finished.logs.map((log) => log.commandKey)).toEqual(['personnel.dismiss', 'offer.cancel']);
  });
  it('국가 발령과 개인 탈국이 같은 턴에 일어나도 새 제안 취소를 기록한다', () => {
    const before = world();
    const assigned = applied(assignGeneral(before, 4, 3, 4, 200));
    assigned.state.generals[4]!.nationId = null;
    assigned.state.generals[4]!.officerLevel = 0;
    const finished = finishPersonnelStep(before, assigned, {}, 200);
    expect(finished.closedOffers[0]).toMatchObject({
      id: '200-4-3',
      status: 'CANCELLED',
      cancelReason: 'ISSUER_LOST_OFFICE',
    });
    expect(finished.state.assignmentOffers).toBeUndefined();
  });
  it('발령자의 권한 유지 이동은 제안을 취소하지 않는다', () => {
    const before = applied(assignGeneral(world(), 4, 3, 4, 123)).state;
    const outcome = applyPersonnelInput(before, event({ payload: { generalId: 4, officerLevel: 11 } }), context);
    if (outcome.status !== 'APPLIED') throw new Error('임명 실패');
    expect(finishPersonnelStep(before, outcome.change, {}, 200).closedOffers).toEqual([]);
  });
  it.each([true, false])('발령 응답 %s를 적용하고 재생한다', (accept) => {
    const state = applied(assignGeneral(world(), 4, 3, 4, 123)).state;
    const payload = { offerId: '123-4-3', accept };
    const outcome = applyPersonnelInput(
      deepFreeze(state),
      event({ kind: 'offer.respond', generalId: 3, userId: 'target', payload }),
      context,
    );
    if (outcome.status !== 'APPLIED') throw new Error('응답 실패');
    expect(outcome.result).toMatchObject({
      offerStatus: accept ? 'ACCEPTED' : 'REJECTED',
      dedicationLost: accept ? 0 : 9,
    });
    const record = validatePersonnelRecord(
      { sequence: 1, generalId: 3, kind: 'offer.respond', payload, status: 'APPLIED', result: outcome.result },
      { monthlyTick: 0 },
    );
    if (record.kind !== 'offer.respond' || record.status !== 'APPLIED') throw new Error('기록 종류');
    expect(replayPersonnelInput(state, record)).toEqual(outcome.change);
    expect(finishPersonnelStep(state, outcome.change, {}, 200).closedOffers).toHaveLength(1);
  });
  it('국가 멸망 제안을 닫고 종료 누락은 계속 거부한다', () => {
    const state = applied(assignGeneral(world(), 4, 3, 4, 123)).state;
    const gone = structuredClone(state);
    removeNation(gone, 1);
    const saved = structuredClone({ state, gone });
    const result = finishPersonnelStep(
      deepFreeze(state),
      deepFreeze({ state: gone, closedOffers: [], logs: [] }),
      {},
      200,
    );
    expect(result.closedOffers).toEqual([
      { id: '123-4-3', status: 'CANCELLED', resolvedBy: null, resolvedTick: 200, cancelReason: 'NATION_DESTROYED' },
    ]);
    expect(result.logs.map(({ commandKey }) => commandKey)).toEqual(['offer.cancel']);
    expect(result.state.generals).toEqual(gone.generals);
    expect(result.state.generals[3]!.dedication).toBe(95);
    expect(Object.hasOwn(result.state, 'assignmentOffers')).toBe(false);
    expect({ state, gone }).toEqual(saved);
    const lost = structuredClone(state);
    delete lost.assignmentOffers;
    expect(() => finishPersonnelStep(state, { state: lost, closedOffers: [], logs: [] }, {}, 200)).toThrow();
  });
});

describe('인사 기록과 직책 칸', () => {
  it('형식이 정상이어도 현재 직책 revision이 다르면 거부한다', () => {
    const record = turnRecord();
    expect(() => applyNationTurnsRecord(world(), { 1: { 5: { revision: 7, tenure: 0 } } }, record)).toThrow();
    record.payload.revision = 7;
    record.payload.office.tenure = 3;
    record.result.revision = 8;
    const offices = deepFreeze({ 1: { 5: { revision: 7, tenure: 3 } } });
    const result = applyNationTurnsRecord(world(), offices, record);
    expect(result.offices[1]?.[5]).toEqual({ revision: 8, tenure: 3 });
    expect(offices[1][5]).toEqual({ revision: 7, tenure: 3 });
  });
  it('교체 직후 발령자가 떠나면 이전 제안과 새 제안을 각각 닫는다', () => {
    const before = applied(assignGeneral(world(), 4, 3, 4, 123)).state;
    const change = applied(assignGeneral(before, 4, 3, 1, 200));
    change.state.generals[4]!.nationId = null;
    change.state.generals[4]!.officerLevel = 0;
    const result = finishPersonnelStep(deepFreeze(before), change, {}, 200);
    expect(result.closedOffers.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: '123-4-3', status: 'SUPERSEDED' },
      { id: '200-4-3', status: 'CANCELLED' },
    ]);
    expect(result.state.generals[3]!.dedication).toBe(95);
  });
  it('종료 기록 중복과 직책 칸의 인자 누락을 거부한다', () => {
    const before = applied(assignGeneral(world(), 4, 3, 4, 123)).state;
    const next = structuredClone(before);
    next.cities[4]!.nationId = 2;
    const closed = {
      id: '123-4-3',
      status: 'CANCELLED',
      resolvedBy: null,
      cancelReason: 'CITY_LOST',
      resolvedTick: 200,
    } as const;
    expect(() => finishPersonnelStep(before, { state: next, closedOffers: [closed], logs: [] }, {}, 200)).toThrow();
    const record = turnRecord();
    expect(() =>
      validatePersonnelRecord(
        {
          ...record,
          payload: { ...record.payload, turns: Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest' })) },
        },
        { monthlyTick: 0 },
      ),
    ).toThrow();
  });
  const rejectedRecord = () => ({
    sequence: 1,
    generalId: 1,
    kind: 'personnel.appoint',
    status: 'REJECTED',
    payload: { generalId: 3, officerLevel: 12 },
    result: { tick: 200, code: 'BAD_ARGS', message: '직책 오류' },
  });
  it.each([
    { sequence: 0 },
    { sequence: 2_147_483_648 },
    { extra: 0 },
    { payload: null },
    { result: { tick: 200, code: 'OFFER_CLOSED', message: '오류' } },
    { result: { tick: -1, code: 'BAD_ARGS', message: '오류' } },
    { result: { tick: 200, code: 'BAD_ARGS', message: '' } },
  ])('거절 기록도 구조 검사를 거친다: %j', (change) => {
    expect(() => validatePersonnelRecord({ ...rejectedRecord(), ...change }, { monthlyTick: 0 })).toThrow();
  });
  it('월간과 종료 경계를 검사한다', () => {
    expect(() => validatePersonnelRecord(rejectedRecord(), { monthlyTick: 201 })).toThrow();
    expect(() => validatePersonnelRecord(rejectedRecord(), { monthlyTick: 0, endTick: 100 })).toThrow();
    const closed = { ...rejectedRecord(), result: { tick: 200, code: 'WORLD_CLOSED', message: '종료' } };
    expect(validatePersonnelRecord(closed, { monthlyTick: 0, endTick: 200 })).toEqual(closed);
  });
  it('재생 결과 위조를 거부한다', () => {
    const { before, result } = appoint();
    const record = validatePersonnelRecord(
      {
        sequence: 1,
        generalId: 1,
        kind: 'personnel.appoint',
        status: 'APPLIED',
        payload: event().payload,
        result: { ...result.result, title: '다른 이름' },
      },
      { monthlyTick: 0 },
    );
    if (record.kind !== 'personnel.appoint' || record.status !== 'APPLIED') throw new Error('기록 종류');
    expect(() => replayPersonnelInput(before, record)).toThrow();
  });
  it('직책 칸은 tick 없이 12칸과 revision을 재생한다', () => {
    const state = deepFreeze(world());
    const record = deepFreeze(turnRecord());
    const result = applyNationTurnsRecord(state, {}, record);
    expect(result.offices[1]?.[5]).toEqual({ revision: 1, tenure: 0 });
    expect(result.state.officeTurns?.[1]?.[5]).toHaveLength(12);
    expect(state.officeTurns).toBeUndefined();
    expect(validatePersonnelRecord(record, { monthlyTick: 999, endTick: 999 })).toEqual(record);
  });
  it.each(['tenure', 'revision', 'office', 'command', 'args', 'length'] as const)(
    '직책 칸의 %s 불일치를 거부한다',
    (failure) => {
      const record = turnRecord();
      if (failure === 'tenure') record.payload.office.tenure = 1;
      if (failure === 'revision') record.result.revision = 2;
      if (failure === 'office') record.payload.office.officerLevel = 11;
      if (failure === 'command') record.payload.turns[0]!.commandKey = 'nation_capital';
      if (failure === 'args') record.payload.turns[0]!.args = { extra: true };
      if (failure === 'length') record.payload.turns.pop();
      expect(() => applyNationTurnsRecord(world(), {}, record)).toThrow();
    },
  );
  it('직책 칸에 거절 상태나 tick을 추가하지 못한다', () => {
    const record = turnRecord();
    expect(() => validatePersonnelRecord({ ...record, status: 'REJECTED' }, { monthlyTick: 0 })).toThrow();
    expect(() =>
      validatePersonnelRecord({ ...record, result: { revision: 1, tick: 0 } }, { monthlyTick: 0 }),
    ).toThrow();
  });
});
