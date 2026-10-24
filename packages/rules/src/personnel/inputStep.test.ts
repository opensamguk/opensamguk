import { describe, expect, it } from 'vitest';
import {
  validatePersonnelRecord,
  type NationTurnsRecord,
  type PendingPersonnelEvent,
  type PersonnelInputContext,
  type PersonnelRecordedInput,
} from './inputs';
import { applyPersonnelInputStep, applyPersonnelRecordStep } from './inputStep';
import { assignGeneral } from './assignments';
import type { OfficeRevisions, OfficeState } from './offices';
import { applied, deepFreeze, personnelWorld } from './testFixture';
import { PersonnelInvariantError } from './types';

const context = { tick: 100, worldStatus: 'RUNNING', userActive: true } as const;
function world(): OfficeState {
  const state = personnelWorld();
  state.generals[1]!.userId = 'ruler';
  return state;
}
function request(changes: Partial<PendingPersonnelEvent> = {}): PendingPersonnelEvent {
  return {
    kind: 'personnel.appoint',
    userId: 'ruler',
    generalId: 1,
    idempotencyKey: 'personnel:10000000-0000-4000-8000-000000000001',
    payload: { generalId: 3, officerLevel: 11 },
    ...changes,
  };
}
function parity(state: OfficeState, event: PendingPersonnelEvent, offices: OfficeRevisions = {}) {
  const saved = structuredClone({ state, event, offices });
  const live = applyPersonnelInputStep(deepFreeze(state), deepFreeze(offices), deepFreeze(event), context);
  if (live.status !== 'APPLIED') throw new Error(live.result.message);
  const record = validatePersonnelRecord(
    {
      sequence: 1,
      generalId: event.generalId,
      kind: event.kind,
      status: live.status,
      payload: event.payload,
      result: live.result,
    },
    { monthlyTick: 0 },
  );
  const replay = applyPersonnelRecordStep(deepFreeze({ state, offices }), deepFreeze(record), context.tick);
  expect(replay.packet).toEqual(live.packet);
  expect(replay.state).toEqual(live.packet.state);
  expect(replay.offices).toEqual(live.packet.offices);
  expect({ state, event, offices }).toEqual(saved);
  return { live, replay, record };
}
function appointmentRecord(): PersonnelRecordedInput {
  const state = world();
  const live = applyPersonnelInputStep(state, {}, request(), context);
  if (live.status !== 'APPLIED') throw new Error(live.result.message);
  return validatePersonnelRecord(
    {
      sequence: 1,
      generalId: 1,
      kind: 'personnel.appoint',
      status: 'APPLIED',
      payload: request().payload,
      result: live.result,
    },
    { monthlyTick: 0 },
  );
}
function turnsRecord(): NationTurnsRecord {
  const record = validatePersonnelRecord(
    {
      sequence: 1,
      generalId: 4,
      kind: 'nationTurns.set',
      status: 'APPLIED',
      payload: {
        office: { nationId: 1, officerLevel: 5, tenure: 2 },
        revision: 7,
        turns: Array.from({ length: 12 }, () => ({
          commandKey: 'nation_reward',
          args: { generalId: 3, resource: 'gold', amount: 1 },
        })),
      },
      result: { revision: 8 },
    },
    { monthlyTick: 0 },
  );
  if (record.kind !== 'nationTurns.set') throw new Error('직책 칸 기록이 아닙니다.');
  return record;
}

describe('인사 입력 step의 live와 재생 조합', () => {
  it('실제 임명의 직책 칸 초기화와 카운터를 같은 packet으로 마무리한다', () => {
    const { live } = parity(world(), request());
    expect(live.packet.state.generals[3]!.officerLevel).toBe(11);
    expect(live.packet.offices).toEqual({ 1: { 11: { revision: 1, tenure: 1 } } });
    expect(live.packet.state.officeTurns![1]![11]).toHaveLength(12);
    expect(live.packet.logs.map((log) => log.commandKey)).toEqual(['personnel.appoint']);
    expect(live.packet.state.generals[3]!.nextTurnTick).toBe(5000);
    expect(Object.hasOwn(live.packet, 'policy')).toBe(false);
  });

  it('실제 해임 뒤 기존 발령 제안 취소와 로그 순서가 같다', () => {
    const state = applied(assignGeneral(world(), 4, 3, 4, 0)).state;
    const { live } = parity(state, request({ kind: 'personnel.dismiss', payload: { generalId: 4 } }));
    expect(live.packet.assignment.closedOffers).toEqual([
      { id: '0-4-3', status: 'CANCELLED', resolvedBy: null, resolvedTick: 100, cancelReason: 'ISSUER_LOST_OFFICE' },
    ]);
    expect(live.packet.logs.map((log) => log.commandKey)).toEqual(['personnel.dismiss', 'offer.cancel']);
    expect(live.packet.offices).toEqual({ 1: { 5: { revision: 1, tenure: 1 } } });
  });

  it.each([true, false])('발령 응답 값 %s의 실제 결과와 종료 기록이 같다', (accept) => {
    const state = applied(assignGeneral(world(), 4, 3, 4, 0)).state;
    const { live } = parity(
      state,
      request({ kind: 'offer.respond', userId: 'target', generalId: 3, payload: { offerId: '0-4-3', accept } }),
    );
    expect(live.packet.state.generals[3]!.cityKey).toBe(accept ? 4 : 1);
    expect(live.packet.state.generals[3]!.dedication).toBe(accept ? 95 : 86);
    expect(live.packet.assignment.closedOffers[0]).toMatchObject({
      status: accept ? 'ACCEPTED' : 'REJECTED',
      resolvedBy: 'RESPONSE',
      resolvedTick: 100,
    });
    expect(live.packet.assignment.final).toEqual({});
  });

  it.each([
    ['대상 없음', request({ payload: { generalId: 99, officerLevel: 11 } }), context, 'BAD_TARGET'],
    ['다른 사용자', request({ userId: 'other' }), context, 'NO_GENERAL'],
    ['비활성 사용자', request(), { ...context, userActive: false }, 'ACTOR_INACTIVE'],
    ['닫힌 월드', request(), { ...context, worldStatus: 'ENDED' }, 'WORLD_CLOSED'],
  ] as const)('거절 사유 %s에서는 packet 없이 상태와 카운터를 보존한다', (_, event, current, code) => {
    const state = deepFreeze(world());
    const offices = deepFreeze({ 1: { 5: { revision: 7, tenure: 2 } } });
    const saved = structuredClone({ state, offices });
    const result = applyPersonnelInputStep(state, offices, deepFreeze(event), current as PersonnelInputContext);
    expect(result).toMatchObject({ status: 'REJECTED', result: { code, tick: 100 } });
    expect(Object.hasOwn(result, 'packet')).toBe(false);
    expect(Object.hasOwn(result, 'policy')).toBe(false);
    expect({ state, offices }).toEqual(saved);
  });

  it('검사한 REJECTED 기록도 재생 helper에서는 적용하지 않는다', () => {
    const state = world();
    const event = request({ payload: { generalId: 99, officerLevel: 11 } });
    const live = applyPersonnelInputStep(state, {}, event, context);
    const record = validatePersonnelRecord(
      { sequence: 1, generalId: 1, kind: event.kind, status: live.status, payload: event.payload, result: live.result },
      { monthlyTick: 0 },
    );
    const current = deepFreeze({ state, offices: {} });
    expect(() => applyPersonnelRecordStep(current, deepFreeze(record), 100)).toThrow('인사 입력을 재생할 수 없습니다.');
    expect(state.generals[3]!.officerLevel).toBe(1);
  });

  it('즉시 행동 기록과 다른 명시 tick을 거부한다', () => {
    expect(() =>
      applyPersonnelRecordStep(deepFreeze({ state: world(), offices: {} }), deepFreeze(appointmentRecord()), 101),
    ).toThrow('인사 입력 tick이 기록과 다릅니다.');
  });

  it('기록 result를 바꾸면 실제 도메인 재계산에서 거부한다', () => {
    const record = appointmentRecord();
    if (record.kind !== 'personnel.appoint' || record.status !== 'APPLIED') throw new Error('임명 기록이 아닙니다.');
    record.result.title = '다른 직책';
    expect(() =>
      applyPersonnelRecordStep(deepFreeze({ state: world(), offices: {} }), deepFreeze(record), 100),
    ).toThrow('인사 입력 결과가 기록과 다릅니다.');
  });

  it('직책 칸 편집도 packet으로 마무리하고 revision을 한 번만 올린다', () => {
    const state = world();
    const offices = { 1: { 5: { revision: 7, tenure: 2 } } };
    const record = turnsRecord();
    const saved = structuredClone({ state, offices, record });
    const step = applyPersonnelRecordStep(deepFreeze({ state, offices }), deepFreeze(record), 10000);
    expect(step.offices).toEqual({ 1: { 5: { revision: 8, tenure: 2 } } });
    expect(step.packet.office.before.offices).toEqual(offices);
    expect(step.packet.office.next.offices).toEqual(step.offices);
    expect(step.state.officeTurns![1]![5]).toEqual(record.payload.turns);
    expect(step.packet.assignment.closedOffers).toEqual([]);
    expect(step.packet.logs).toEqual([]);
    expect({ state, offices, record }).toEqual(saved);
    expect(Object.hasOwn(record.payload, 'tick')).toBe(false);
    expect(Object.hasOwn(record.result, 'tick')).toBe(false);
  });

  it.each(['revision', 'tenure'] as const)('직책 칸 카운터의 이전 값(%s)을 거부한다', (field) => {
    const record = turnsRecord();
    if (field === 'revision') {
      record.payload.revision = 6;
      record.result.revision = 7;
    } else record.payload.office.tenure = 1;
    const current = deepFreeze({ state: world(), offices: { 1: { 5: { revision: 7, tenure: 2 } } } });
    expect(() => applyPersonnelRecordStep(current, deepFreeze(record), 100)).toThrow(
      '직책 칸의 장수·직책·revision이 다릅니다.',
    );
  });

  it.each([undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '빠지거나 잘못된 tick 값(%s)을 거부한다',
    (tick) => {
      const current = deepFreeze({ state: world(), offices: { 1: { 5: { revision: 7, tenure: 2 } } } });
      expect(() => applyPersonnelRecordStep(current, deepFreeze(turnsRecord()), tick as number)).toThrow(
        PersonnelInvariantError,
      );
      expect(current.offices[1]![5]!.revision).toBe(7);
    },
  );

  it('수뇌의 직책 칸에 군주 명령을 넣으면 도메인 권한 검사에서 거부한다', () => {
    const record = turnsRecord();
    record.payload.turns[0] = { commandKey: 'nation_declare', args: { nationId: 2 } };
    const current = deepFreeze({ state: world(), offices: { 1: { 5: { revision: 7, tenure: 2 } } } });
    expect(() => applyPersonnelRecordStep(current, deepFreeze(record), 100)).toThrow(
      '직책 칸 명령과 인자가 올바르지 않습니다.',
    );
  });
});
