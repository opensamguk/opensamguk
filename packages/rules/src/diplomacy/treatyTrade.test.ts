import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import {
  applyTreatyInput,
  decodeTreatyRecord,
  quoteTreatyProposal,
  validateTreatyRecord,
  validateTreatyState,
  validateClosedTreatyRow,
  validateBrokenTreatyRow,
} from './treaty';
import type { TreatyClause } from './treatyTypes';
const options = { tradeEnabled: true };
function proposal(clauses: TreatyClause[] = [{ kind: 'trade', months: 12 }], enabled = true) {
  const state = commandWorld();
  state.nations[2]!.isNpc = false;
  state.diplomacies = [];
  return applyTreatyInput(
    state,
    { kind: 'treaty.propose', generalId: 1, payload: { toNationId: 2, clauses } },
    { tick: 15000, sequence: 10, tradeEnabled: enabled },
  );
}
function accepted(clauses?: TreatyClause[]) {
  const proposed = proposal(clauses);
  if (!proposed.ok) throw Error(proposed.result.message);
  const result = applyTreatyInput(
    proposed.state,
    { kind: 'treaty.respond', generalId: 2, payload: { treatyId: '10', accept: true } },
    { tick: 16000, sequence: 20, ...options },
  );
  if (!result.ok || result.result.outcome !== 'ACCEPTED') throw Error('수락 실패');
  return result;
}
describe('T2-07 / AC-M2-06·14 교역 조항 선택', () => {
  it('기본 선택은 교역을 계속 거절한다', () =>
    expect(proposal(undefined, false)).toMatchObject({ ok: false, result: { code: 'CLAUSE_NOT_CONNECTED' } }));
  it('교역만 수락하면 기간과 양국 비용을 저장하고 불가침 관계는 만들지 않는다', () => {
    const result = accepted();
    expect(result.result).toMatchObject({ cost: { from: 200, to: 100 }, endTick: 136000 });
    expect(result.state.treaties![0]!.clauses).toEqual([{ kind: 'trade', months: 12 }]);
    expect(result.state.diplomacies).toEqual([]);
    expect(() => validateTreatyState(result.state.treaties![0])).toThrow();
    expect(validateTreatyState(result.state.treaties![0], options)).toEqual(result.state.treaties![0]);
  });
  it('가장 긴 기간의 비용은 한 번만 내고 불가침은 자기 기간으로 끝난다', () => {
    const result = accepted([
      { kind: 'nonAggression', months: 3 },
      { kind: 'trade', months: 12 },
    ]);
    expect(result.result).toMatchObject({ cost: { from: 200, to: 100 }, endTick: 136000 });
    expect(result.state.diplomacies).toEqual([{ nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 46000 }]);
  });
  it.each([0, 121])('교역 %i개월은 잘못된 조항이다', (months) =>
    expect(proposal([{ kind: 'trade', months }])).toMatchObject({ ok: false, result: { code: 'BAD_INPUT' } }),
  );
  it('다른 미연결 조항은 계속 거절한다', () =>
    expect(
      proposal([
        { kind: 'passage', cityKeys: [1] },
        { kind: 'trade', months: 12 },
      ]),
    ).toMatchObject({ ok: false, result: { code: 'CLAUSE_NOT_CONNECTED' } }));
  it('교역 포함 제안 기록은 선택된 기능 문맥에서만 해독한다', () => {
    const result = proposal();
    if (!result.ok) throw Error('제안 실패');
    const record = {
      sequence: 10,
      generalId: 1,
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses: [{ kind: 'trade', months: 12 }] },
      status: 'APPLIED',
      result: result.result,
    };
    expect(() => decodeTreatyRecord(record)).toThrow();
    expect(decodeTreatyRecord(record, options)).toEqual(record);
    expect(() => validateTreatyRecord(record, { treaty: { version: 1 }, monthlyTick: 10000 })).toThrow();
    expect(
      validateTreatyRecord(record, { treaty: { version: 1 }, treatyTrade: { version: 1 }, monthlyTick: 10000 }),
    ).toEqual(record);
  });
  it.each(['ENDED', 'BROKEN'] as const)('닫힌 %s 행도 선택된 교역 기간을 검증한다', (status) => {
    const result = accepted();
    if (result.result.outcome !== 'ACCEPTED') throw Error('수락 실패');
    const row = {
      ...result.state.treaties![0]!,
      status,
      costFrom: result.result.cost.from,
      costTo: result.result.cost.to,
      closedSequence: 30,
    };
    const validate = status === 'BROKEN' ? validateBrokenTreatyRow : validateClosedTreatyRow;
    expect(() => validate(row)).toThrow();
    expect(validate(row, options)).toEqual(row);
    expect(() => validate({ ...row, endTick: row.endTick! + 1 }, options)).toThrow();
  });
  it('불가침이 이미 끝났으면 파기가 같은 쌍의 새 관계를 지우지 않는다', () => {
    const result = accepted([
      { kind: 'nonAggression', months: 3 },
      { kind: 'trade', months: 12 },
    ]);
    result.state.diplomacies[0]!.untilTick = 200000;
    const broken = applyTreatyInput(
      result.state,
      { kind: 'treaty.break', generalId: 1, payload: { treatyId: '10' } },
      { tick: 60000, sequence: 30, ...options },
    );
    expect(broken.ok).toBe(true);
    if (broken.ok) expect(broken.state.diplomacies).toEqual(result.state.diplomacies);
  });
  it('견적도 가장 긴 기간으로만 계산한다', () =>
    expect(
      quoteTreatyProposal(
        {
          fromNationId: 1,
          toNationId: 2,
          clauses: [
            { kind: 'nonAggression', months: 3 },
            { kind: 'trade', months: 12 },
          ],
          fromCityCount: 2,
          target: { relation: 'NONE', cityCount: 1 },
        },
        options,
      ),
    ).toEqual({ cost: { from: 200, to: 100 }, problem: null }));
});
