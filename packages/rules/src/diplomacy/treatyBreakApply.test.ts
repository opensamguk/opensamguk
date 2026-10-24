import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import type { WorldState } from '../model/world';
import { applyTreatyInput, decodeTreatyRecord, TREATY_INPUTS, validateTreatyRecord } from './treaty';
import type { FirstTreatyClause } from './treatyTypes';

function active(clauses: FirstTreatyClause[] = [{ kind: 'peace' }, { kind: 'nonAggression', months: 3 }]) {
  const result = applyTreatyInput(
    commandWorld(),
    { kind: 'treaty.propose', generalId: 1, payload: { toNationId: 2, clauses } },
    { tick: 100, sequence: 10 },
  );
  if (!result.ok || result.result.outcome !== 'ACCEPTED') throw new Error('수락한 조약을 만들지 못했습니다.');
  return result.state;
}

function perform(state: WorldState, generalId = 1) {
  return applyTreatyInput(
    state,
    { kind: 'treaty.break', generalId, payload: { treatyId: '10' } },
    { tick: 200, sequence: 20 },
  );
}

describe('T2-07 / AC-M2-06 파기 순수 판정', () => {
  it.each([1, 2])('양 당사국 군주 %i의 파기는 신의 한 번과 조약 종료만 남긴다', (generalId) => {
    const before = active();
    const original = structuredClone(before);
    const result = perform(before, generalId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toEqual({ outcome: 'BROKEN', tick: 200, treatyId: '10', brokenByNationId: generalId });
    expect(Object.hasOwn(result.state, 'treaties')).toBe(false);
    expect(result.state.nationTrust).toEqual([{ nationId: generalId, brokenTreaties: 1, lastBrokenTick: 200 }]);
    expect(result.state.diplomacies).toEqual([]);
    expect(result.state.nations).toEqual(before.nations);
    expect(result.state.generals).toEqual(before.generals);
    expect(result.state.cities).toEqual(before.cities);
    expect(before).toEqual(original);
  });

  it('참모도 파기하고 같은 파기를 다시 하면 횟수가 오르지 않는다', () => {
    const state = active();
    state.generals[1]!.officerLevel = 11;
    const result = perform(state);
    if (!result.ok) throw new Error('참모의 파기를 거부했습니다.');
    expect(perform(result.state)).toMatchObject({ ok: false, result: { code: 'TREATY_NOT_ACTIVE' } });
    expect(result.state.nationTrust).toEqual([{ nationId: 1, brokenTreaties: 1, lastBrokenTick: 200 }]);
  });

  it.each([0, 1, 5, 10])('직책 %i는 대상 판정보다 먼저 권한을 거부한다', (officerLevel) => {
    const state = active();
    state.generals[1]!.officerLevel = officerLevel;
    delete state.treaties;
    expect(perform(state)).toMatchObject({ ok: false, result: { code: 'NO_PERMISSION' } });
  });

  it('없는 장수와 재야 장수, 사라진 자기 국가를 구분한다', () => {
    const state = active();
    expect(perform(state, 99)).toMatchObject({ ok: false, result: { code: 'NO_GENERAL' } });
    expect(perform(state, 4)).toMatchObject({ ok: false, result: { code: 'NO_PERMISSION' } });
    delete state.nations[1];
    expect(perform(state)).toMatchObject({ ok: false, result: { code: 'BAD_TARGET' } });
  });

  it('제3국 권한자는 파기할 수 없고 응답 전용 문장을 쓰지 않는다', () => {
    const state = active();
    state.nations[3] = { ...state.nations[2]!, id: 3 };
    state.generals[4]!.nationId = 3;
    state.generals[4]!.officerLevel = 12;
    expect(perform(state, 4)).toEqual({
      ok: false,
      result: { tick: 200, code: 'NOT_PARTY', message: '당사국인 조약만 파기할 수 있습니다.' },
    });
  });

  it('상대국 소멸 뒤 월간 정산 전에는 BAD_TARGET이다', () => {
    const state = active();
    delete state.nations[2];
    expect(perform(state)).toMatchObject({ ok: false, result: { code: 'BAD_TARGET' } });
  });

  it('제안 상태의 조약은 파기하지 않는다', () => {
    const state = commandWorld();
    state.nations[2]!.isNpc = false;
    const proposal = applyTreatyInput(
      state,
      { kind: 'treaty.propose', generalId: 1, payload: { toNationId: 2, clauses: [{ kind: 'note', text: '기록' }] } },
      { tick: 100, sequence: 10 },
    );
    if (!proposal.ok) throw new Error('제안을 만들지 못했습니다.');
    expect(perform(proposal.state)).toMatchObject({ ok: false, result: { code: 'TREATY_NOT_ACTIVE' } });
  });

  it('불가침 없는 조약은 기존 교전 관계를 보존한다', () => {
    const state = active([{ kind: 'note', text: '기록' }]);
    const result = perform(state);
    if (!result.ok) throw new Error('기록 조약을 파기하지 못했습니다.');
    expect(result.state.diplomacies).toEqual(state.diplomacies);
  });

  it('기존 신의는 보존하고 파기 국가의 횟수만 올린다', () => {
    const state = active();
    state.nationTrust = [
      { nationId: 1, brokenTreaties: 2, lastBrokenTick: 150 },
      { nationId: 2, brokenTreaties: 4, lastBrokenTick: 170 },
    ];
    const result = perform(state);
    if (!result.ok) throw new Error('신의 기록을 갱신하지 못했습니다.');
    expect(result.state.nationTrust).toEqual([
      { nationId: 1, brokenTreaties: 3, lastBrokenTick: 200 },
      { nationId: 2, brokenTreaties: 4, lastBrokenTick: 170 },
    ]);
    expect(state.nationTrust[0]!.brokenTreaties).toBe(2);
  });

  it.each([{ treatyId: '01' }, { treatyId: 10 }, { treatyId: '10', generalId: 1 }, {}])(
    '구조가 잘못된 payload는 거절 결과로 감추지 않고 throw한다 (%j)',
    (payload) => {
      expect(() => TREATY_INPUTS['treaty.break'].normalizePayload(payload)).toThrow();
    },
  );

  it('파손된 불가침 관계와 신의 배열은 throw하고 원본을 보존한다', () => {
    const state = active();
    state.diplomacies[0]!.untilTick++;
    const original = structuredClone(state);
    expect(() => perform(state)).toThrow();
    expect(state).toEqual(original);
    const invalidTrust = active();
    invalidTrust.nationTrust = [];
    expect(() => perform(invalidTrust)).toThrow();
  });
});

describe('T2-07 / AC-M2-06 파기 기록 계약', () => {
  const record = {
    sequence: 20,
    generalId: 1,
    kind: 'treaty.break',
    status: 'APPLIED',
    payload: { treatyId: '10' },
    result: { outcome: 'BROKEN', tick: 200, treatyId: '10', brokenByNationId: 1 },
  };
  const context = { treaty: { version: 1 }, treatyBreak: { version: 1 }, monthlyTick: 0 };

  it('중앙 파기 선택이 있을 때만 실행 기록을 검증한다', () => {
    expect(validateTreatyRecord(record, context)).toEqual(record);
    expect(decodeTreatyRecord(record)).toEqual(record);
    expect(() => validateTreatyRecord(record, { treaty: { version: 1 }, monthlyTick: 0 })).toThrow();
    expect(() => validateTreatyRecord(record, { ...context, treatyBreak: null })).toThrow();
  });

  it.each([
    { outcome: 'ACCEPTED', by: 'HUMAN', tick: 200, treatyId: '10', cost: { from: 0, to: 0 }, endTick: null },
    { ...record.result, treatyId: '11' },
    { ...record.result, brokenByNationId: 0 },
    { ...record.result, brokenByNationId: 1.5 },
    { ...record.result, by: 'HUMAN' },
  ])('잘못된 파기 결과를 거부한다 (%j)', (result) => {
    expect(() => decodeTreatyRecord({ ...record, result })).toThrow();
  });

  it('파기의 BAD_INPUT 거절과 다른 kind에 붙은 BROKEN 결과를 거부한다', () => {
    expect(() =>
      decodeTreatyRecord({ ...record, status: 'REJECTED', result: { tick: 200, code: 'BAD_INPUT', message: '오류' } }),
    ).toThrow();
    expect(() =>
      decodeTreatyRecord({ ...record, kind: 'treaty.respond', payload: { treatyId: '10', accept: true } }),
    ).toThrow();
  });

  it.each([10, 9])('파기 순서 %i가 조약 생성 순서보다 뒤가 아니면 거부한다', (sequence) => {
    expect(() => decodeTreatyRecord({ ...record, sequence })).toThrow();
  });
});
