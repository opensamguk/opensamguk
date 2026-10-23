import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { settleDiplomacy } from '../monthly/index';
import { applyTreatyInput, settleTreaties, treatyClosures, TREATY_INPUTS, validateTreatyRecord } from './treaty';
import type { TreatyWorldState } from './treaty';
import type { TreatyClause, TreatyInput, TreatyRecord } from './treatyTypes';
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

function humanWorld(): TreatyWorldState {
  const state = commandWorld();
  state.nations[1]!.isNpc = false;
  state.nations[2]!.isNpc = false;
  return state;
}

const peacePact: TreatyClause[] = [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }];
function propose(state = humanWorld(), clauses = peacePact, tick = 1500, sequence = 10) {
  return applyTreatyInput(
    state,
    { generalId: 1, kind: 'treaty.propose', payload: { toNationId: 2, clauses } },
    { tick, sequence },
  );
}
function pending(clauses = peacePact, tick = 1500): TreatyWorldState {
  const result = propose(humanWorld(), clauses, tick);
  if (!result.ok) throw new Error('제안 준비 실패');
  return result.state;
}
function respond(state: TreatyWorldState, tick = 1501, accept = true, generalId = 2) {
  return applyTreatyInput(
    state,
    { generalId, kind: 'treaty.respond', payload: { treatyId: '10', accept } },
    { tick, sequence: 11 },
  );
}
function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

describe('T2-07 / AC-M2-06 첫 세 조항 처리', () => {
  it('제안은 비용을 보류하고 수락 때 도시 수를 다시 읽어 양국 비용을 차감한다', () => {
    const before = freezeDeep(humanWorld());
    const proposed = propose(before);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.result).toEqual({ outcome: 'PROPOSED', tick: 1500, treatyId: '10', respondByTick: 61500 });
    expect(proposed.state.nations[1]!.gold).toBe(100000);
    expect(before).not.toHaveProperty('treaties');
    proposed.state.cities[3]!.nationId = 2;
    proposed.state.nations[1]!.gold = 17;
    proposed.state.nations[2]!.gold = 17;
    const snapshot = structuredClone(proposed.state);
    const accepted = respond(freezeDeep(proposed.state));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.result).toEqual({
      outcome: 'ACCEPTED',
      by: 'HUMAN',
      tick: 1501,
      treatyId: '10',
      cost: { from: 17, to: 17 },
      endTick: 11501,
    });
    expect(accepted.state.nations[1]!.gold).toBe(0);
    expect(accepted.state.nations[2]!.gold).toBe(0);
    expect(accepted.state.diplomacies).toEqual([{ nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 11501 }]);
    expect(accepted.state.treaties?.[0]).toMatchObject({ status: 'ACTIVE', startTick: 1501, endTick: 11501 });
    expect(proposed.state).toEqual(snapshot);
  });

  it.each([
    [16, 9, 'COUNTERPART_UNAVAILABLE'],
    [17, 8, 'INSUFFICIENT_GOLD'],
    [16, 8, 'INSUFFICIENT_GOLD'],
  ])('수락 국고 %i/%i에서 %s로 거절하며 상태를 보존한다', (from, to, code) => {
    const state = pending();
    state.nations[1]!.gold = from;
    state.nations[2]!.gold = to;
    const snapshot = structuredClone(state);
    expect(respond(freezeDeep(state))).toMatchObject({ ok: false, result: { code } });
    expect(state).toEqual(snapshot);
  });

  it.each([
    [99, 'NO_GENERAL'],
    [3, 'NO_PERMISSION'],
    [4, 'NO_PERMISSION'],
  ] as const)('장수 %i의 제안 권한을 검사한다', (generalId, code) => {
    expect(
      applyTreatyInput(
        humanWorld(),
        { generalId, kind: 'treaty.propose', payload: { toNationId: 2, clauses: peacePact } },
        { tick: 1, sequence: 1 },
      ),
    ).toMatchObject({ ok: false, result: { code } });
  });

  it('참모는 응답할 수 있고 수뇌와 발신국 장수는 응답하지 못한다', () => {
    const state = pending();
    state.generals[2]!.officerLevel = 5;
    expect(respond(state)).toMatchObject({ ok: false, result: { code: 'NO_PERMISSION' } });
    state.generals[2]!.officerLevel = 11;
    expect(respond(state).ok).toBe(true);
    expect(respond(state, 1501, true, 1)).toMatchObject({ ok: false, result: { code: 'NOT_PARTY' } });
  });

  it.each([1, 99])('자기 국가나 없는 국가 %i에는 제안하지 못한다', (toNationId) => {
    expect(
      applyTreatyInput(
        humanWorld(),
        { generalId: 1, kind: 'treaty.propose', payload: { toNationId, clauses: peacePact } },
        { tick: 1, sequence: 1 },
      ),
    ).toMatchObject({ ok: false, result: { code: 'BAD_TARGET' } });
  });

  it.each([false, true])('정확한 응답 기한에는 수락·거절 모두 만료된다 (%s)', (accept) => {
    const state = pending();
    expect(respond(state, 61499, accept).ok).toBe(true);
    expect(respond(state, 61500, accept)).toMatchObject({ ok: false, result: { code: 'EXPIRED' } });
    expect(respond(state, 65000, accept)).toMatchObject({ ok: false, result: { code: 'EXPIRED' } });
    expect(state.treaties?.[0]?.status).toBe('PROPOSED');
  });

  it('사람이 거절하면 국고와 관계를 보존하고 열린 조약만 지운다', () => {
    const state = pending();
    state.nations[1]!.gold = 0;
    state.nations[2]!.gold = 0;
    const result = respond(state, 1501, false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatchObject({ outcome: 'DECLINED', by: 'HUMAN' });
    expect(result.state).not.toHaveProperty('treaties');
    expect(result.state.diplomacies).toEqual(state.diplomacies);
    expect(result.state.nations).toEqual(state.nations);
  });

  it.each(['WAR', 'DECLARED'] as const)('%s에서는 불가침에 종전이 함께 있어야 한다', (relation) => {
    const state = humanWorld();
    state.diplomacies[0]!.state = relation;
    expect(propose(state, [{ kind: 'nonAggression', months: 1 }])).toMatchObject({
      ok: false,
      result: { code: 'TREATY_RELATION' },
    });
    expect(propose(state).ok).toBe(true);
  });

  it('관계 없는 국가는 불가침을 맺고 기존 불가침의 갱신과 종전은 거절한다', () => {
    const state = humanWorld();
    state.diplomacies = [];
    expect(propose(state, [{ kind: 'nonAggression', months: 1 }]).ok).toBe(true);
    state.diplomacies = [{ nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 30000 }];
    for (const clauses of [peacePact, [{ kind: 'peace' }] as TreatyClause[]]) {
      expect(propose(state, clauses)).toMatchObject({ ok: false, result: { code: 'TREATY_RELATION' } });
    }
    expect(propose(state, [{ kind: 'note', text: '통상 기록' }]).ok).toBe(true);
  });

  it.each(['peace', 'note'] as const)('무료 %s 조약은 ACTIVE와 끝 시각 null을 유지한다', (kind) => {
    const state = pending(kind === 'peace' ? [{ kind }] : [{ kind, text: '기록' }]);
    state.nations[1]!.gold = 0;
    state.nations[2]!.gold = 0;
    const result = respond(state);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatchObject({ cost: { from: 0, to: 0 }, endTick: null });
    expect(result.state.treaties?.[0]).toMatchObject({ status: 'ACTIVE', endTick: null });
    expect(result.state.diplomacies).toEqual(kind === 'peace' ? [] : state.diplomacies);
    expect(settleTreaties(result.state, 1000000).treaties).toEqual(result.state.treaties);
  });

  it('수락 때 관계를 다시 검사하고 관계 없는 다른 국가 쌍을 보존한다', () => {
    const state = pending();
    state.diplomacies = [];
    expect(respond(state)).toMatchObject({ ok: false, result: { code: 'TREATY_RELATION' } });
    state.diplomacies = [
      { nationA: 1, nationB: 3, state: 'WAR', untilTick: 0 },
      { nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 },
    ];
    const result = respond(state);
    if (!result.ok) throw new Error('수락 실패');
    expect(result.state.diplomacies.map((d) => [d.nationA, d.nationB])).toEqual([
      [1, 2],
      [1, 3],
    ]);
    expect(result.state.diplomacies[1]).toEqual(state.diplomacies[0]);
    expect(respond(result.state)).toMatchObject({ ok: false, result: { code: 'TREATY_NOT_PROPOSED' } });
  });

  it.each([
    [17, 9, 'ACCEPTED'],
    [17, 8, 'DECLINED'],
  ] as const)('NPC는 자기 국고 %i/%i에 따라 같은 이벤트에서 응답한다 (%s)', (from, to, outcome) => {
    const state = humanWorld();
    state.nations[2]!.isNpc = true;
    state.nations[1]!.gold = from;
    state.nations[2]!.gold = to;
    const result = propose(freezeDeep(state));
    if (!result.ok) throw new Error('NPC 제안 실패');
    expect(result.result).toMatchObject({ outcome, by: 'NPC', treatyId: '10' });
    if (outcome === 'ACCEPTED') {
      expect(result.state.nations[1]!.gold).toBe(0);
      expect(result.state.nations[2]!.gold).toBe(0);
    } else expect(result.state).toEqual(state);
    expect(result.state.generals).toEqual(state.generals);
  });

  it('NPC도 발신국 비용 부족과 공통 관계 검증을 넘지 못한다', () => {
    const state = humanWorld();
    state.nations[2]!.isNpc = true;
    state.nations[1]!.gold = 16;
    expect(propose(state)).toMatchObject({ ok: false, result: { code: 'INSUFFICIENT_GOLD' } });
    expect(propose(state, [{ kind: 'nonAggression', months: 1 }])).toMatchObject({
      ok: false,
      result: { code: 'TREATY_RELATION' },
    });
  });

  it('월 정산에서 미응답 제안과 사라진 국가의 영구 조약을 닫는다', () => {
    const state = pending();
    const beforeDeadline = settleTreaties(state, 60000);
    expect(beforeDeadline.treaties).toEqual(state.treaties);
    const expired = settleTreaties(state, 70000);
    expect(expired).not.toHaveProperty('treaties');
    expect(treatyClosures(state, expired)).toEqual([{ id: 10, status: 'EXPIRED' }]);
    const accepted = respond(pending([{ kind: 'note', text: '기록' }]));
    if (!accepted.ok) throw new Error('수락 실패');
    delete accepted.state.nations[2];
    const ended = settleTreaties(accepted.state, 10000);
    expect(ended).not.toHaveProperty('treaties');
    expect(treatyClosures(accepted.state, ended)).toEqual([{ id: 10, status: 'ENDED' }]);
  });

  it('11500에 끝나는 조약과 외교는 B10000에 남고 기존 외교 정산 뒤 B20000에 사라진다', () => {
    const accepted = respond(pending(), 1500);
    if (!accepted.ok) throw new Error('수락 실패');
    const atFirst = settleTreaties(settleDiplomacy(accepted.state, 10000), 10000);
    expect(atFirst.treaties?.[0]?.endTick).toBe(11500);
    expect(atFirst.diplomacies).toHaveLength(1);
    const atSecond = settleTreaties(settleDiplomacy(atFirst, 20000), 20000);
    expect(atSecond).not.toHaveProperty('treaties');
    expect(atSecond.diplomacies).toEqual([]);
    expect(treatyClosures(atFirst, atSecond)).toEqual([{ id: 10, status: 'ENDED' }]);
  });

  it('열린 조약과 월 정산 종료 목록을 ID로 정렬한다', () => {
    const first = pending([{ kind: 'note', text: '첫 기록' }]);
    const second = propose(first, [{ kind: 'note', text: '다음 기록' }], 1501, 3);
    if (!second.ok) throw new Error('제안 실패');
    expect(second.state.treaties?.map((t) => t.id)).toEqual([3, 10]);
    second.state.treaties?.reverse();
    expect(treatyClosures(second.state, settleTreaties(second.state, 70000))).toEqual([
      { id: 3, status: 'EXPIRED' },
      { id: 10, status: 'EXPIRED' },
    ]);
    expect(() => propose(first, [{ kind: 'note', text: '중복 순서' }])).toThrow();
  });

  it('저장 범위를 넘는 파생 기한은 줄이지 않고 예외로 알린다', () => {
    const state = freezeDeep(humanWorld());
    expect(() => propose(state, peacePact, 2147483647 - 59999)).toThrow(RangeError);
    expect(state).not.toHaveProperty('treaties');
    const nearEnd = pending([{ kind: 'peace' }, { kind: 'nonAggression', months: 120 }], 2147483647 - 60000);
    expect(() => respond(nearEnd, 2147483647 - 1)).toThrow(RangeError);
    expect(nearEnd.treaties?.[0]?.status).toBe('PROPOSED');
    expect(() => settleTreaties(state, 1500)).toThrow(RangeError);
  });
});

const recordContext = { treaty: { version: 1 }, monthlyTick: 0 };
function proposedRecord(): TreatyRecord {
  return {
    sequence: 10,
    generalId: 1,
    kind: 'treaty.propose',
    status: 'APPLIED',
    payload: { toNationId: 2, clauses: peacePact },
    result: { outcome: 'PROPOSED', tick: 1500, treatyId: '10', respondByTick: 61500 },
  };
}

describe('T2-07 / AC-M2-06 구조 검사와 게임 거절', () => {
  it('raw 조항 정렬과 NFC 변환 뒤에만 저장 payload를 검사한다', () => {
    const raw = { toNationId: 2, clauses: [{ kind: 'note', text: '\u1100\u1161' }, { kind: 'peace' }] };
    expect(() => TREATY_INPUTS['treaty.propose'].payloadSchema.parse(raw)).toThrow();
    expect(TREATY_INPUTS['treaty.propose'].normalizePayload(raw)).toEqual({
      toNationId: 2,
      clauses: [{ kind: 'peace' }, { kind: 'note', text: '가' }],
    });
    expect(raw.clauses[0]?.text).toBe('\u1100\u1161');
  });

  it.each([
    { toNationId: 2, clauses: null },
    { toNationId: 2, clauses: [{ kind: 'unknown' }] },
    { toNationId: 2, clauses: [{ kind: 'nonAggression', months: '1' }] },
    { toNationId: 2, clauses: [{ kind: 'nonAggression', months: 1.5 }] },
    { toNationId: 2, clauses: [{ kind: 'peace', cost: 0 }] },
    { toNationId: 2, clauses: [], generalId: 1 },
  ])('구조가 틀린 raw 제안은 게임 거절로 바꾸지 않는다 (%j)', (payload) => {
    expect(() => TREATY_INPUTS['treaty.propose'].normalizePayload(payload)).toThrow();
  });

  it.each<{ clauses: TreatyClause[] }>([
    { clauses: [] },
    { clauses: [{ kind: 'peace' }, { kind: 'peace' }] },
    { clauses: [{ kind: 'nonAggression', months: 0 }] },
    { clauses: [{ kind: 'nonAggression', months: 121 }] },
    { clauses: [{ kind: 'note', text: '' }] },
    { clauses: [{ kind: 'note', text: '가'.repeat(301) }] },
  ])('모양이 맞는 잘못된 조항은 BAD_INPUT이다 (%j)', ({ clauses }) => {
    expect(propose(humanWorld(), clauses)).toMatchObject({ ok: false, result: { code: 'BAD_INPUT' } });
  });

  it.each<TreatyClause>([
    { kind: 'passage', cityKeys: [] },
    { kind: 'tribute', payerNationId: -1, gold: -1, rice: 0, months: 0 },
    { kind: 'trade', months: 0 },
    { kind: 'cityTransfer', cityKey: -1, giverNationId: -1 },
  ])('뒤 조항의 모양만 확인하고 CLAUSE_NOT_CONNECTED로 돌려준다 (%j)', (clause) => {
    expect(propose(humanWorld(), [clause])).toMatchObject({ ok: false, result: { code: 'CLAUSE_NOT_CONNECTED' } });
  });

  it('NFC 뒤 코드 포인트로 기록 길이를 센다', () => {
    expect(propose(humanWorld(), [{ kind: 'note', text: '𠀀'.repeat(300) }]).ok).toBe(true);
    const normalized = TREATY_INPUTS['treaty.propose'].normalizePayload({
      toNationId: 2,
      clauses: [{ kind: 'note', text: '\u1100\u1161'.repeat(300) }],
    });
    expect(propose(humanWorld(), normalized.clauses).ok).toBe(true);
  });

  it('동일한 입력을 적용해 저장 결과와 대조할 수 있다', () => {
    const record = validateTreatyRecord(proposedRecord(), recordContext);
    const replay = applyTreatyInput(humanWorld(), record, { tick: record.result.tick, sequence: record.sequence });
    expect(replay.ok).toBe(true);
    expect(replay.result).toEqual(record.result);
    expect(() =>
      validateTreatyRecord({ ...record, result: { ...record.result, respondByTick: 61501 } }, recordContext),
    ).toThrow();
  });

  it.each(['APPLIED', 'REJECTED'] as const)('%s도 외피와 payload를 먼저 검사한다', (status) => {
    const base = proposedRecord();
    const result = status === 'APPLIED' ? base.result : { tick: 1500, code: 'WORLD_CLOSED', message: '종료' };
    const value = { ...base, status, result };
    expect(validateTreatyRecord(value, recordContext).status).toBe(status);
    for (const corrupt of [
      { generalId: null },
      { sequence: 0 },
      { sequence: 1.5 },
      { actor: 1 },
      { payload: { toNationId: 2, clauses: [{ kind: 'note', text: null }] } },
    ]) {
      expect(() => validateTreatyRecord({ ...value, ...corrupt }, recordContext)).toThrow();
    }
    for (const tick of [-1, 1.5, '1500', Number.MAX_SAFE_INTEGER + 1, 2147483648]) {
      expect(() => validateTreatyRecord({ ...value, result: { ...result, tick } }, recordContext)).toThrow();
    }
  });

  it('빈 조항의 BAD_INPUT 기록은 유효하지만 응답의 BAD_INPUT과 알 수 없는 코드는 막는다', () => {
    const rejected = {
      ...proposedRecord(),
      status: 'REJECTED',
      payload: { toNationId: 2, clauses: [] },
      result: { tick: 1500, code: 'BAD_INPUT', message: '조항 확인' },
    };
    expect(validateTreatyRecord(rejected, recordContext).status).toBe('REJECTED');
    expect(() =>
      validateTreatyRecord({ ...rejected, result: { ...rejected.result, code: 'ANY_CODE' } }, recordContext),
    ).toThrow();
    expect(() =>
      validateTreatyRecord(
        { ...rejected, kind: 'treaty.respond', payload: { treatyId: '10', accept: false } },
        recordContext,
      ),
    ).toThrow();
  });

  it('제안·응답의 결과 주체, ID, accept, 정확한 결과 키를 검사한다', () => {
    const accepted = {
      outcome: 'ACCEPTED',
      by: 'NPC',
      tick: 1500,
      treatyId: '10',
      cost: { from: 17, to: 9 },
      endTick: 11500,
    };
    const base = { ...proposedRecord(), result: accepted };
    expect(validateTreatyRecord(base, recordContext).result).toEqual(accepted);
    for (const result of [
      { ...accepted, by: 'HUMAN' },
      { ...accepted, treatyId: '11' },
      { ...accepted, cost: { from: 17, to: -1 } },
      { ...accepted, cost: { from: 17, to: 9, extra: 1 } },
      { ...accepted, extra: 1 },
      { ...accepted, endTick: 11501 },
    ]) {
      expect(() => validateTreatyRecord({ ...base, result }, recordContext)).toThrow();
    }
    const response = {
      ...base,
      kind: 'treaty.respond',
      payload: { treatyId: '10', accept: true },
      result: { ...accepted, by: 'HUMAN' },
    };
    expect(validateTreatyRecord(response, recordContext).kind).toBe('treaty.respond');
    expect(() =>
      validateTreatyRecord({ ...response, payload: { treatyId: '10', accept: false } }, recordContext),
    ).toThrow();
    expect(() => validateTreatyRecord({ ...response, result: accepted }, recordContext)).toThrow();
    expect(() => validateTreatyRecord({ ...base, payload: { toNationId: 2, clauses: [] } }, recordContext)).toThrow();
  });

  it('capability와 월 정산 하한을 검사하되 적체 입력을 다음 월 경계로 제한하지 않는다', () => {
    expect(() => validateTreatyRecord(proposedRecord(), { treaty: null, monthlyTick: 0 })).toThrow();
    expect(() => validateTreatyRecord(proposedRecord(), { treaty: { version: 2 }, monthlyTick: 0 })).toThrow();
    expect(() => validateTreatyRecord(proposedRecord(), { ...recordContext, monthlyTick: 10000 })).toThrow();
    const backlog = {
      ...proposedRecord(),
      result: { outcome: 'PROPOSED', tick: 25000, treatyId: '10', respondByTick: 85000 },
    };
    expect(validateTreatyRecord(backlog, { ...recordContext, monthlyTick: 10000 }).result.tick).toBe(25000);
  });

  it('종료 뒤에는 종료 시각 이상의 WORLD_CLOSED 기록만 받는다', () => {
    const context = { ...recordContext, endTick: 20000 };
    const value = {
      ...proposedRecord(),
      status: 'REJECTED',
      result: { tick: 20000, code: 'WORLD_CLOSED', message: '종료' },
    };
    expect(validateTreatyRecord(value, context).result.tick).toBe(20000);
    expect(() => validateTreatyRecord({ ...value, result: { ...value.result, tick: 19999 } }, context)).toThrow();
    expect(() => validateTreatyRecord({ ...value, result: { ...value.result, code: 'BAD_INPUT' } }, context)).toThrow();
    expect(() => validateTreatyRecord(proposedRecord(), context)).toThrow();
    expect(() => validateTreatyRecord({ ...value, payload: null }, context)).toThrow();
  });

  it('구조 검사만으로 위조 비용을 확정하지 않고 실제 재실행 결과와 대조한다', () => {
    const state = humanWorld();
    state.nations[2]!.isNpc = true;
    const forged = {
      ...proposedRecord(),
      result: { outcome: 'ACCEPTED', by: 'NPC', tick: 1500, treatyId: '10', cost: { from: 0, to: 0 }, endTick: 11500 },
    };
    const record = validateTreatyRecord(forged, recordContext);
    const replay = applyTreatyInput(state, record as TreatyInput & { generalId: number }, { tick: 1500, sequence: 10 });
    expect(replay.result).not.toEqual(record.result);
  });
});
