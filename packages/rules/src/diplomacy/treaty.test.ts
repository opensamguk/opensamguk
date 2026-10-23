import { describe, expect, it } from 'vitest';
import { calculateTreatyFee, canNpcAcceptTreaty, meetsTreatyPeaceRequirement, settleTreatyFees } from './treaty';

describe('T2-07 / AC-M2-06 승인된 첫 조약의 순수 비용과 수락 조건', () => {
  it.each([
    [1, 1, 9],
    [1, 5, 42],
    [3, 4, 100],
    [0, 12, 0],
    [1, 120, 1000],
    [2, 12, 200],
    [7, 12, 700],
  ])('도시 %i개, 불가침 %i개월의 비용을 계산한다 (금 %i)', (cities, months, expected) => {
    expect(calculateTreatyFee(cities, months)).toBe(expected);
  });

  it('국가마다 자기 도시 수로 내며 상대 규모를 섞지 않는다', () => {
    const cost = { from: calculateTreatyFee(2, 12), to: calculateTreatyFee(7, 12) };
    expect(settleTreatyFees({ from: 500, to: 1000 }, cost)).toEqual({
      ok: true,
      gold: { from: 300, to: 300 },
    });
  });

  it('불가침 없는 종전·기록 조약은 금 0인 두 국가도 낼 수 있다', () => {
    expect(calculateTreatyFee(7, null)).toBe(0);
    expect(settleTreatyFees({ from: 0, to: 0 }, { from: 0, to: 0 })).toEqual({
      ok: true,
      gold: { from: 0, to: 0 },
    });
  });

  it.each([
    { from: 199, to: 700 },
    { from: 200, to: 699 },
    { from: 199, to: 699 },
  ])('한쪽이라도 부족하면 양국 국고를 모두 보존한다: %j', (initial) => {
    const gold = Object.freeze(initial);
    const cost = Object.freeze({ from: 200, to: 700 });
    const before = { ...gold };
    expect(settleTreatyFees(gold, cost)).toEqual({ ok: false, gold: before });
    expect(gold).toEqual(before);
    expect(cost).toEqual({ from: 200, to: 700 });
  });

  it('양쪽이 정확히 비용을 보유하면 새 결과만 0으로 만들고 입력을 보존한다', () => {
    const gold = Object.freeze({ from: 200, to: 700 });
    const cost = Object.freeze({ from: 200, to: 700 });
    expect(settleTreatyFees(gold, cost)).toEqual({ ok: true, gold: { from: 0, to: 0 } });
    expect(gold).toEqual({ from: 200, to: 700 });
  });

  it('중간 곱이 안전 정수를 넘어도 최종 비용이 표현 가능하면 올림이 정확하다', () => {
    expect(calculateTreatyFee(900719925474098, 1)).toBe(7505999378950817);
  });

  it.each([0, 121, 1.5, NaN, Infinity])('잘못된 불가침 개월을 거부한다 (%s)', (months) => {
    expect(() => calculateTreatyFee(1, months)).toThrow(RangeError);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('잘못된 도시 수를 거부한다 (%s)', (cities) => {
    expect(() => calculateTreatyFee(cities, 12)).toThrow(RangeError);
  });

  it('최종 비용이 안전 정수를 넘으면 반올림된 금액을 돌려주지 않는다', () => {
    expect(() => calculateTreatyFee(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
  });

  it.each(['from', 'to'] as const)('국고나 비용이 잘못되면 차감하지 않는다 (%s)', (side) => {
    expect(() => settleTreatyFees({ from: 100, to: 100, [side]: -1 }, { from: 1, to: 1 })).toThrow(RangeError);
    expect(() => settleTreatyFees({ from: 100, to: 100 }, { from: 1, to: 1, [side]: 0.5 })).toThrow(RangeError);
  });

  it.each(['WAR', 'DECLARED'] as const)('%s에서 불가침에는 같은 조약의 종전이 필요하다', (relation) => {
    expect(meetsTreatyPeaceRequirement(relation, { peace: false, nonAggression: true })).toBe(false);
    expect(meetsTreatyPeaceRequirement(relation, { peace: true, nonAggression: true })).toBe(true);
    expect(meetsTreatyPeaceRequirement(relation, { peace: false, nonAggression: false })).toBe(true);
  });

  it('관계가 없으면 이 조건만으로 불가침을 거절하지 않는다', () => {
    expect(meetsTreatyPeaceRequirement('NONE', { peace: false, nonAggression: true })).toBe(true);
  });

  const validNpcProposal = {
    valid: true,
    clauseKinds: ['peace', 'nonAggression', 'note'] as const,
    gold: 59,
    cost: calculateTreatyFee(7, 1),
  };

  it('NPC는 자기 비용과 같은 국고면 수락하고 금 1이 부족하면 거절한다', () => {
    expect(validNpcProposal.cost).toBe(59);
    expect(canNpcAcceptTreaty(validNpcProposal)).toBe(true);
    expect(canNpcAcceptTreaty({ ...validNpcProposal, gold: 58 })).toBe(false);
  });

  it.each(['peace', 'note'])('NPC는 무료 %s 제안을 국고 0에도 수락한다', (kind) => {
    expect(canNpcAcceptTreaty({ valid: true, clauseKinds: [kind], gold: 0, cost: 0 })).toBe(true);
  });

  it.each(['passage', 'tribute', 'trade', 'cityTransfer'])('NPC는 %s 조항이 섞이면 거절한다', (kind) => {
    expect(canNpcAcceptTreaty({ ...validNpcProposal, clauseKinds: ['peace', 'nonAggression', 'note', kind] })).toBe(
      false,
    );
  });

  it('NPC는 종전 없는 전쟁 중 불가침의 공통 검증 실패를 넘지 못한다', () => {
    const valid = meetsTreatyPeaceRequirement('WAR', { peace: false, nonAggression: true });
    expect(canNpcAcceptTreaty({ ...validNpcProposal, valid, clauseKinds: ['nonAggression'] })).toBe(false);
  });

  it('NPC는 기간 등 다른 공통 검증에 실패하면 금이 충분해도 거절한다', () => {
    expect(canNpcAcceptTreaty({ ...validNpcProposal, valid: false })).toBe(false);
  });
});
