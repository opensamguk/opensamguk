import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import {
  decodeTreatyRecord as publicDecode,
  validateClosedTreatyRow as publicClosed,
  type ClosedTreatyRow as PublicClosedTreatyRow,
} from '../index';
import {
  applyTreatyInput,
  calculateTreatyFee,
  decodeTreatyRecord,
  settleTreaties,
  treatyClosures,
  treatyRespondByTick,
  validateClosedTreatyRow,
  validateTreatyRecord,
  validateTreatyState,
  type TreatyWorldState,
} from './treaty';
import type { ClosedTreatyRow, FirstTreatyClause, TreatyInput, TreatyRecord } from './treatyTypes';

const pact: FirstTreatyClause[] = [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }];
const note: FirstTreatyClause[] = [{ kind: 'note', text: '기록' }];
const replayContext = { treaty: { version: 1 }, monthlyTick: 0 };

function world(npc = false): TreatyWorldState {
  const state = commandWorld();
  state.nations[1]!.isNpc = false;
  state.nations[2]!.isNpc = npc;
  return state;
}

// 이 fixture는 월간 정산 전의 실제 순수 입력을 엔진과 같은 완료 6칸으로 검사한다.
function execute(state: TreatyWorldState, input: TreatyInput & { generalId: number }, tick: number, sequence: number) {
  const applied = applyTreatyInput(state, input, { tick, sequence });
  const record = validateTreatyRecord(
    {
      sequence,
      generalId: input.generalId,
      kind: input.kind,
      payload: input.payload,
      status: applied.ok ? 'APPLIED' : 'REJECTED',
      result: applied.result,
    },
    replayContext,
  );
  return { state: applied.ok ? applied.state : state, record };
}

function proposal(npc = false, tick = 1500, clauses = pact, state = world(npc)) {
  return execute(state, { generalId: 1, kind: 'treaty.propose', payload: { toNationId: 2, clauses } }, tick, 10);
}

function response(state: TreatyWorldState, accept: boolean, tick = 1501) {
  return execute(state, { generalId: 2, kind: 'treaty.respond', payload: { treatyId: '10', accept } }, tick, 11);
}

function accepted(npc = false, tick = 1500, clauses = pact) {
  const proposed = proposal(npc, tick, clauses);
  const result = npc ? proposed : response(proposed.state, true, tick + 1);
  if (result.record.status !== 'APPLIED' || result.record.result.outcome !== 'ACCEPTED')
    throw new Error('수락 fixture를 만들지 못했습니다.');
  const row = result.state.treaties![0]!;
  return {
    ...result,
    stored: { ...row, costFrom: result.record.result.cost.from, costTo: result.record.result.cost.to },
  };
}

function ended(npc = false, tick = 1500, clauses = pact): ClosedTreatyRow {
  const result = accepted(npc, tick, clauses);
  const before = structuredClone(result.state);
  if (result.stored.endTick === null) delete before.nations[2];
  const closeTick = Math.ceil((result.stored.endTick ?? tick) / 10000) * 10000;
  const next = settleTreaties(before, closeTick);
  const closure = treatyClosures(before, next)[0];
  if (!closure || closure.status !== 'ENDED') throw new Error('마감 fixture를 만들지 못했습니다.');
  return { ...result.stored, status: closure.status, closedSequence: 20 };
}

function expired(tick = 1500, clauses = pact): ClosedTreatyRow {
  const result = proposal(false, tick, clauses);
  const row = result.state.treaties![0]!;
  const next = settleTreaties(result.state, Math.ceil(row.respondByTick / 10000) * 10000);
  const closure = treatyClosures(result.state, next)[0];
  if (!closure || closure.status !== 'EXPIRED') throw new Error('만료 fixture를 만들지 못했습니다.');
  return { ...row, status: closure.status, costFrom: null, costTo: null, closedSequence: 20 };
}

function humanDeclined(): ClosedTreatyRow {
  const proposed = proposal();
  const result = response(proposed.state, false);
  if (result.record.status !== 'APPLIED' || result.record.result.outcome !== 'DECLINED')
    throw new Error('거절 fixture를 만들지 못했습니다.');
  return {
    ...proposed.state.treaties![0]!,
    status: 'REJECTED',
    costFrom: null,
    costTo: null,
    closedSequence: result.record.sequence,
  };
}

function npcDeclined(tick = 1500, clauses = pact) {
  const state = world(true);
  const months = clauses.find((clause) => clause.kind === 'nonAggression')?.months ?? null;
  const cities = Object.values(state.cities).filter((city) => city.nationId === 2).length;
  state.nations[2]!.gold = calculateTreatyFee(cities, months) - 1;
  const result = proposal(true, tick, clauses, state);
  if (result.record.status !== 'APPLIED' || result.record.result.outcome !== 'DECLINED')
    throw new Error('NPC 거절 fixture를 만들지 못했습니다.');
  const stored: ClosedTreatyRow = {
    id: Number(result.record.result.treatyId),
    fromNationId: 1,
    toNationId: 2,
    clauses: structuredClone(clauses),
    status: 'REJECTED',
    proposedTick: result.record.result.tick,
    respondByTick: treatyRespondByTick(result.record.result.tick),
    startTick: null,
    endTick: null,
    costFrom: null,
    costTo: null,
    closedSequence: result.record.sequence,
  };
  return { ...result, stored };
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

describe('T2-07 / AC-M2-06 닫힌 조약 저장 행', () => {
  it.each([
    ['사람 거절', humanDeclined],
    ['사람 만료', expired],
    ['사람 기간 종료', ended],
    ['사람 무료 종료', () => ended(false, 1500, note)],
    ['NPC 거절', () => npcDeclined().stored],
    ['NPC 기간 종료', () => ended(true)],
  ] as const)('실제 순수 판정과 월간 마감으로 만든 행을 읽는다 (%s)', (_, fixture) => {
    const row = fixture();
    expect(validateClosedTreatyRow(row)).toEqual(row);
  });

  it('무료 NPC 끝점 수락 뒤 국가 소멸로 마감한 이력을 보존한다', () => {
    const active = accepted(true, 2147423647, note);
    expect(validateTreatyState(active.state.treaties![0]!)).toMatchObject({
      proposedTick: 2147423647,
      respondByTick: 2147483647,
      startTick: 2147423647,
      endTick: null,
    });
    expect(validateClosedTreatyRow(ended(true, 2147423647, note))).toMatchObject({
      status: 'ENDED',
      proposedTick: 2147423647,
      respondByTick: 2147483647,
      costFrom: 0,
      costTo: 0,
      endTick: null,
    });
  });

  it('NPC 120개월의 마지막 진행 가능한 월 경계 종료를 읽는다', () => {
    const row = ended(true, 2146270000, [{ kind: 'peace' }, { kind: 'nonAggression', months: 120 }]);
    expect(validateClosedTreatyRow(row)).toMatchObject({
      proposedTick: 2146270000,
      startTick: 2146270000,
      endTick: 2147470000,
      status: 'ENDED',
    });
  });

  it('NPC 즉시 거절의 같은 sequence와 Int 끝점 기한을 읽는다', () => {
    const { stored } = npcDeclined(2147423647);
    expect(stored.closedSequence).toBe(stored.id);
    expect(validateClosedTreatyRow(stored)).toMatchObject({
      respondByTick: 2147483647,
      startTick: null,
      endTick: null,
      costFrom: null,
      costTo: null,
    });
    expect(() => validateClosedTreatyRow({ ...stored, status: 'EXPIRED', closedSequence: 20 })).toThrow();
  });

  it('사람 무료 제안의 마지막 응답 기한에서 만료한 행을 읽는다', () => {
    expect(validateClosedTreatyRow(expired(2147410000, note))).toMatchObject({
      respondByTick: 2147470000,
      status: 'EXPIRED',
    });
  });

  it('공개 함수와 타입을 쓰며 원래 status·분해형 글자·객체를 보존한다', () => {
    const row: PublicClosedTreatyRow = freezeDeep(ended(false, 1500, [{ kind: 'note', text: '\u1100\u1161' }]));
    expect(publicClosed).toBe(validateClosedTreatyRow);
    const parsed = publicClosed(row);
    expect(parsed).toEqual(row);
    expect(parsed).not.toBe(row);
    expect(parsed.clauses).not.toBe(row.clauses);
    expect(parsed.clauses[0]).not.toBe(row.clauses[0]);
    expect(parsed.clauses[0]).toEqual({ kind: 'note', text: '\u1100\u1161' });
  });

  it('12칸 중 어느 칸도 생략하지 않는다', () => {
    const row = ended();
    expect(Object.keys(row)).toHaveLength(12);
    for (const key of Object.keys(row)) {
      const missing = { ...row } as Record<string, unknown>;
      delete missing[key];
      expect(() => validateClosedTreatyRow(missing), key).toThrow();
    }
  });

  it.each([
    { worldId: '다른 월드' },
    { extra: true },
    { status: 'PROPOSED' },
    { status: 'ACTIVE' },
    { status: 'BROKEN' },
    { id: 0 },
    { id: 1.5 },
    { id: 2147483648 },
    { fromNationId: 0 },
    { fromNationId: 2147483648 },
    { toNationId: '2' },
    { toNationId: 2147483648 },
    { fromNationId: 2 },
    { closedSequence: null },
    { closedSequence: 0 },
    { closedSequence: 1.5 },
    { closedSequence: 2147483648 },
    { closedSequence: 10 },
    { costFrom: null },
    { costTo: null },
    { costFrom: -1 },
    { costTo: 1.5 },
    { costFrom: 2147483648 },
    { costTo: 2147483648 },
    { proposedTick: -1 },
    { proposedTick: 1.5 },
    { proposedTick: 2147473648 },
    { respondByTick: -1 },
    { respondByTick: 61501 },
    { respondByTick: 2147483648 },
    { startTick: null },
    { startTick: 1499 },
    { startTick: 61500 },
    { startTick: 2147483648 },
    { endTick: null },
    { endTick: 11502 },
    { endTick: 2147483648 },
  ])('파손된 저장 metadata와 시각을 거부한다 (%j)', (patch) => {
    const row = freezeDeep({ ...ended(), ...patch });
    const before = structuredClone(row);
    expect(() => validateClosedTreatyRow(row)).toThrow();
    expect(row).toEqual(before);
  });

  it.each(
    [
      [],
      [{ kind: 'peace' }, { kind: 'peace' }],
      [{ kind: 'passage', cityKeys: [1] }],
      [{ kind: 'nonAggression', months: 0 }],
      [{ kind: 'nonAggression', months: 121 }],
      [{ kind: 'nonAggression', months: 1.5 }],
      [{ kind: 'note', text: '' }],
      [{ kind: 'note', text: '가'.repeat(301) }],
      [{ kind: 'note', text: '기록' }, { kind: 'peace' }],
      [{ kind: 'peace', extra: 1 }],
    ].map((clauses) => [clauses] as const),
  )('닫힌 행도 조항 도메인과 저장 순서를 검사한다 (%j)', (clauses) => {
    expect(() => validateClosedTreatyRow({ ...ended(), clauses })).toThrow();
  });

  it.each(['REJECTED', 'EXPIRED'] as const)('수락하지 않은 행에 납부·시작·끝을 허용하지 않는다 (%s)', (status) => {
    const row = status === 'REJECTED' ? humanDeclined() : expired();
    for (const patch of [{ startTick: 1501 }, { endTick: 11501 }, { costFrom: 0 }, { costTo: 0 }])
      expect(() => validateClosedTreatyRow({ ...row, ...patch })).toThrow();
  });

  it('거절 sequence는 id보다 작을 수 없고 만료·종료는 같을 수도 없다', () => {
    const row = npcDeclined().stored;
    expect(validateClosedTreatyRow(row).closedSequence).toBe(row.id);
    expect(() => validateClosedTreatyRow({ ...row, closedSequence: row.id - 1 })).toThrow();
    expect(() => validateClosedTreatyRow({ ...expired(), closedSequence: 10 })).toThrow();
    expect(() => validateClosedTreatyRow({ ...ended(), closedSequence: 10 })).toThrow();
  });

  it('거절도 공통 표현 범위를 넘는 개월과 기한을 받지 않는다', () => {
    const row = npcDeclined(2147423647).stored;
    expect(() => validateClosedTreatyRow({ ...row, clauses: [{ kind: 'nonAggression', months: 5 }] })).toThrow();
    expect(() => validateClosedTreatyRow({ ...row, proposedTick: 2147423648, respondByTick: 2147483647 })).toThrow();
  });

  it('종료는 도달 가능한 시작과 종료 경계를 지킨다', () => {
    const row = ended(true, 2147423647, note);
    expect(() => validateClosedTreatyRow({ ...row, startTick: 2147473647 })).toThrow();
    const long = ended(true, 2146270000, [{ kind: 'peace' }, { kind: 'nonAggression', months: 120 }]);
    expect(() => validateClosedTreatyRow({ ...long, startTick: long.startTick! + 1, endTick: 2147470001 })).toThrow();
    expect(() => validateClosedTreatyRow({ ...row, endTick: row.startTick })).toThrow();
  });

  it.each([1499, 61500])('무기간 조약의 시작 경계를 다른 조건과 따로 검사한다 (%i)', (startTick) => {
    const row = ended(false, 1500, note);
    expect(row.endTick).toBeNull();
    expect(() => validateClosedTreatyRow({ ...row, startTick })).toThrow('시작 시각');
  });

  it('현재 국고나 월드 순서를 추정하지 않고 Int 끝값 비용·마감 순서를 운반한다', () => {
    const row = { ...ended(), costFrom: 2147483647, costTo: 0, closedSequence: 2147483647 };
    expect(validateClosedTreatyRow(row)).toEqual(row);
  });
});

function completedRecords(): TreatyRecord[] {
  const proposed = proposal();
  const demoted = world();
  demoted.generals[1]!.officerLevel = 1;
  return [
    proposed.record,
    response(proposed.state, true).record,
    accepted(true).record,
    response(proposed.state, false).record,
    npcDeclined().record,
    proposal(false, 1500, []).record,
    response(proposed.state, true, 61500).record,
    proposal(false, 1500, pact, demoted).record,
  ];
}

describe('T2-07 / AC-M2-06 과거 완료 조약 decoder', () => {
  it.each(completedRecords().map((record) => [record.kind, record.status, record] as const))(
    '옛 완료 기록은 현재 정산·종료 context 없이 읽는다 (%s, %s)',
    (_, __, record) => {
      expect(decodeTreatyRecord(record)).toEqual(record);
      expect(() => validateTreatyRecord(record, { ...replayContext, monthlyTick: 100000 })).toThrow();
      expect(() => validateTreatyRecord(record, { ...replayContext, endTick: 100000 })).toThrow();
      expect(validateTreatyRecord(record, replayContext)).toEqual(decodeTreatyRecord(record));
    },
  );

  it('공개 decoder는 입력과 중첩 결과를 깊이 복사한다', () => {
    expect(publicDecode).toBe(decodeTreatyRecord);
    const record = freezeDeep(accepted(true).record);
    const parsed = publicDecode(record);
    expect(parsed).toEqual(record);
    expect(parsed).not.toBe(record);
    expect(parsed.payload).not.toBe(record.payload);
    expect(parsed.result).not.toBe(record.result);
    if (parsed.kind !== 'treaty.propose' || parsed.status !== 'APPLIED' || parsed.result.outcome !== 'ACCEPTED')
      throw new Error('decoder fixture의 결과가 다릅니다.');
    expect(parsed.payload.clauses).not.toBe((record.payload as { clauses: unknown }).clauses);
    parsed.payload.clauses.push({ kind: 'note', text: '사본' });
    parsed.result.cost.from++;
    expect(record).toEqual(accepted(true).record);
  });

  it('NFC로 바꾸지 않고 실제 BAD_INPUT·연결 전 조항 거절을 읽는다', () => {
    const nfd = proposal(false, 1500, [{ kind: 'note', text: '\u1100\u1161' }]).record;
    expect(decodeTreatyRecord(nfd)).toEqual(nfd);
    const unsupported = execute(
      world(),
      { generalId: 1, kind: 'treaty.propose', payload: { toNationId: 2, clauses: [{ kind: 'trade', months: 1 }] } },
      1500,
      10,
    ).record;
    expect(unsupported).toMatchObject({ status: 'REJECTED', result: { code: 'CLAUSE_NOT_CONNECTED' } });
    expect(decodeTreatyRecord(unsupported)).toEqual(unsupported);
  });

  it.each([
    { status: 'PENDING', sequence: null, result: null },
    { sequence: 0 },
    { sequence: null },
    { sequence: 2147483648 },
    { generalId: null },
    { kind: 'treaty.break' },
    { extra: true },
    { payload: null },
    { payload: { toNationId: 2, clauses: pact, extra: 1 } },
    { result: { outcome: 'PROPOSED', tick: 1500, treatyId: '11', respondByTick: 61500 } },
    { result: { outcome: 'PROPOSED', tick: 1500, treatyId: '10', respondByTick: 61501 } },
    { result: { outcome: 'PROPOSED', tick: 2147483648, treatyId: '10', respondByTick: 61500 } },
    { result: { outcome: 'PROPOSED', tick: 1500, treatyId: '10', respondByTick: 61500, extra: 1 } },
    { payload: { toNationId: 2, clauses: [] } },
  ])('완료 외피와 결과의 모순을 거부한다 (%j)', (patch) => {
    const record = freezeDeep({ ...proposal().record, ...patch });
    const before = structuredClone(record);
    expect(() => decodeTreatyRecord(record)).toThrow();
    expect(record).toEqual(before);
  });

  it('NPC 제안 수락의 by·기한과 사람 응답의 accept를 검사한다', () => {
    const npc = accepted(true).record;
    const human = accepted().record;
    if (npc.status !== 'APPLIED' || human.status !== 'APPLIED') throw new Error('수락 기록이 없습니다.');
    for (const result of [
      { ...npc.result, by: 'HUMAN' },
      { ...npc.result, endTick: 11501 },
      { ...npc.result, cost: { from: 1, to: -1 } },
    ])
      expect(() => decodeTreatyRecord({ ...npc, result })).toThrow();
    expect(() => decodeTreatyRecord({ ...human, payload: { treatyId: '10', accept: false } })).toThrow();
    expect(() => decodeTreatyRecord({ ...human, result: { ...human.result, by: 'NPC' } })).toThrow();
  });

  it('거절 코드는 kind별로 검사하고 빈 문장이나 남는 결과 칸을 거부한다', () => {
    const rejected = completedRecords().find((record) => record.status === 'REJECTED')!;
    if (rejected.status !== 'REJECTED') throw new Error('거절 기록이 없습니다.');
    expect(rejected).toMatchObject({ result: { code: 'BAD_INPUT' } });
    for (const result of [
      { ...rejected.result, code: 'UNKNOWN' },
      { ...rejected.result, message: '' },
      { ...rejected.result, extra: 1 },
      { ...rejected.result, tick: 2147483648 },
    ])
      expect(() => decodeTreatyRecord({ ...rejected, result })).toThrow();
    expect(() =>
      decodeTreatyRecord({ ...rejected, kind: 'treaty.respond', payload: { treatyId: '10', accept: true } }),
    ).toThrow();
  });

  it('기존 validator는 capability·parse·context·일관성 순서를 지킨다', () => {
    const record = proposal().record;
    const wrongId = { ...record, result: { ...record.result, treatyId: '11' } };
    expect(() => validateTreatyRecord(null, { treaty: null, monthlyTick: -1 })).toThrow('조약 기능');
    expect(() => validateTreatyRecord(null, { ...replayContext, monthlyTick: -1 })).toThrow('monthlyTick');
    expect(() => validateTreatyRecord(wrongId, { ...replayContext, monthlyTick: 20000 })).toThrow('이미 정산한');
    expect(() => validateTreatyRecord(wrongId, replayContext)).toThrow('조약 기록의 ID');
    expect(() => decodeTreatyRecord(wrongId)).toThrow('조약 기록의 ID');
  });

  it('종료 뒤 WORLD_CLOSED 기록도 context 검사와 로컬 검사를 구분한다', () => {
    const value = {
      ...proposal().record,
      status: 'REJECTED',
      result: { tick: 20000, code: 'WORLD_CLOSED', message: '종료된 월드입니다.' },
    };
    expect(validateTreatyRecord(value, { ...replayContext, endTick: 20000 })).toEqual(decodeTreatyRecord(value));
    expect(() => validateTreatyRecord(value, { ...replayContext, endTick: 20001 })).toThrow('종료 뒤');
  });
});
