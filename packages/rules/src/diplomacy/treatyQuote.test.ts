import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import {
  quoteTreatyProposal as publicQuote,
  type TreatyQuoteCode as PublicCode,
  type TreatyQuoteResult as PublicResult,
} from '../index';
import {
  applyTreatyInput,
  calculateTreatyFee,
  quoteTreatyProposal,
  TREATY_INPUTS,
  type TreatyRelation,
} from './treaty';
import type { TreatyClause } from './treatyTypes';

const pact: TreatyClause[] = [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }];
function world(relation: TreatyRelation = 'WAR', npc = false) {
  const state = commandWorld();
  state.nations[1]!.isNpc = false;
  state.nations[2]!.isNpc = npc;
  state.generals[1]!.nationId = 1;
  state.generals[1]!.officerLevel = 12;
  state.generals[2]!.nationId = 2;
  state.generals[2]!.officerLevel = 12;
  state.diplomacies = relation === 'NONE' ? [] : [{ nationA: 1, nationB: 2, state: relation, untilTick: 90000 }];
  return state;
}
function normalize(clauses: TreatyClause[], toNationId = 2) {
  return TREATY_INPUTS['treaty.propose'].normalizePayload({ toNationId, clauses });
}
function preview(clauses: TreatyClause[] = pact, relation: TreatyRelation = 'WAR') {
  return { fromNationId: 1, ...normalize(clauses), fromCityCount: 2, target: { relation, cityCount: 1 } };
}
function execute(clauses: TreatyClause[], relation: TreatyRelation = 'WAR', toNationId = 2) {
  return applyTreatyInput(
    world(relation),
    { generalId: 1, kind: 'treaty.propose', payload: normalize(clauses, toNationId) },
    { tick: 1500, sequence: 10 },
  );
}
function freeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('T2-07 / AC-M2-06 첫 세 조항 견적', () => {
  it('Q1 도메인 거절과 연결하지 않은 네 조항은 실제 제안 판정과 같다', () => {
    const bad: TreatyClause[][] = [
      [],
      [{ kind: 'peace' }, { kind: 'peace' }],
      [
        { kind: 'note', text: '가' },
        { kind: 'note', text: '나' },
      ],
      [{ kind: 'nonAggression', months: 0 }],
      [{ kind: 'nonAggression', months: 121 }],
      [{ kind: 'note', text: '' }],
      [{ kind: 'note', text: '가'.repeat(301) }],
      [{ kind: 'passage', cityKeys: [1] }],
      [{ kind: 'tribute', payerNationId: 1, gold: 0, rice: 0, months: 1 }],
      [{ kind: 'trade', months: 1 }],
      [{ kind: 'cityTransfer', cityKey: 1, giverNationId: 1 }],
    ];
    for (const clauses of bad) {
      const engine = execute(clauses);
      expect(engine.ok).toBe(false);
      if (engine.ok) throw new Error('거절 fixture 실패');
      expect(quoteTreatyProposal(preview(clauses))).toEqual({
        cost: null,
        problem: { code: engine.result.code, message: engine.result.message },
      });
    }
    expect(quoteTreatyProposal(preview([])).problem?.code).toBe('BAD_INPUT');
    expect(quoteTreatyProposal(preview([{ kind: 'trade', months: 1 }])).problem?.code).toBe('CLAUSE_NOT_CONNECTED');
  });

  it('Q2 자기 국가·없는 상대는 BAD_TARGET이며 조항 검사가 먼저다', () => {
    for (const toNationId of [1, 999, 2147483648]) {
      const engine = execute(pact, 'WAR', toNationId);
      expect(engine.ok).toBe(false);
      if (engine.ok) throw new Error('대상 fixture 실패');
      const input = { ...preview(), toNationId, target: null };
      expect(quoteTreatyProposal(input)).toEqual({
        cost: null,
        problem: { code: 'BAD_TARGET', message: engine.result.message },
      });
    }
    expect(quoteTreatyProposal({ ...preview(), toNationId: 1 }).problem?.code).toBe('BAD_TARGET');
    const engine = execute([], 'WAR', 999);
    if (engine.ok) throw new Error('검사 순서 fixture 실패');
    expect(quoteTreatyProposal({ ...preview([]), toNationId: 999, target: null }).problem?.code).toBe(
      engine.result.code,
    );
  });

  it('Q3 네 관계와 첫 세 조항의 조합은 기존 관계 판정과 같다', () => {
    const combinations: TreatyClause[][] = [
      [{ kind: 'peace' }],
      [{ kind: 'nonAggression', months: 1 }],
      [{ kind: 'note', text: '기록' }],
      pact,
      [{ kind: 'peace' }, { kind: 'note', text: '기록' }],
      [
        { kind: 'nonAggression', months: 1 },
        { kind: 'note', text: '기록' },
      ],
      [...pact, { kind: 'note', text: '기록' }],
    ];
    for (const relation of ['NONE', 'WAR', 'DECLARED', 'NON_AGGRESSION'] as const) {
      for (const clauses of combinations) {
        const engine = execute(clauses, relation);
        const result = quoteTreatyProposal(preview(clauses, relation));
        if (engine.ok) expect(result.problem).toBeNull();
        else {
          expect(engine.result.code).toBe('TREATY_RELATION');
          expect(result.problem).toEqual({ code: engine.result.code, message: engine.result.message });
        }
        expect(result.cost).not.toBeNull();
      }
    }
  });

  it('Q4 양국 비용은 실제 수락과 같고 공개값이 같으면 국고·NPC와 무관하다', () => {
    for (const months of [1, 12, 120]) {
      const clauses: TreatyClause[] = [{ kind: 'peace' }, { kind: 'nonAggression', months }];
      const result = quoteTreatyProposal(preview(clauses));
      expect(result).toEqual({
        cost: { from: calculateTreatyFee(2, months), to: calculateTreatyFee(1, months) },
        problem: null,
      });
      for (const npc of [false, true]) {
        const state = world('WAR', npc);
        const first = applyTreatyInput(
          state,
          { generalId: 1, kind: 'treaty.propose', payload: normalize(clauses) },
          { tick: 1500, sequence: 10 },
        );
        if (!first.ok) throw new Error('수락 제안 fixture 실패');
        const accepted = npc
          ? first
          : applyTreatyInput(
              first.state,
              { generalId: 2, kind: 'treaty.respond', payload: { treatyId: '10', accept: true } },
              { tick: 1501, sequence: 11 },
            );
        if (!accepted.ok || accepted.result.outcome !== 'ACCEPTED') throw new Error('수락 fixture 실패');
        expect(result.cost).toEqual(accepted.result.cost);
      }
    }
    const input = preview();
    for (const npc of [false, true])
      for (const gold of [0, 100000]) {
        const state = world('WAR', npc);
        state.nations[2]!.gold = gold;
        const projection = {
          ...input,
          target: {
            relation: state.diplomacies[0]!.state,
            cityCount: Object.values(state.cities).filter((city) => city.nationId === 2).length,
          },
        };
        expect(quoteTreatyProposal(projection)).toEqual(quoteTreatyProposal(input));
        if (npc) {
          const engine = applyTreatyInput(
            state,
            { generalId: 1, kind: 'treaty.propose', payload: normalize(pact) },
            { tick: 1500, sequence: 10 },
          );
          expect(engine.ok).toBe(true);
          if (!engine.ok) throw new Error('NPC 국고 fixture 실패');
          expect(engine.result.outcome).toBe(gold === 0 ? 'DECLINED' : 'ACCEPTED');
        }
      }
    expect(quoteTreatyProposal(preview([{ kind: 'note', text: '기록' }], 'NONE')).cost).toEqual({ from: 0, to: 0 });
    const poorNpc = world('NONE', true);
    poorNpc.nations[2]!.gold = 0;
    const freeNote = applyTreatyInput(
      poorNpc,
      { generalId: 1, kind: 'treaty.propose', payload: normalize([{ kind: 'note', text: '기록' }]) },
      { tick: 1500, sequence: 10 },
    );
    expect(freeNote).toMatchObject({ ok: true, result: { outcome: 'ACCEPTED', cost: { from: 0, to: 0 } } });
  });

  it('Q5 잘못된 호출은 throw하며 입력과 명시 export를 보존한다', () => {
    const input = freeze(preview());
    const before = structuredClone(input);
    expect(publicQuote).toBe(quoteTreatyProposal);
    const result: PublicResult = publicQuote(input);
    const code: PublicCode = 'BAD_INPUT';
    expect(result.problem).toBeNull();
    expect(quoteTreatyProposal(preview([])).problem?.code).toBe(code);
    expect(input).toEqual(before);
    for (const invalid of [
      { ...preview(), clauses: [{ kind: 'note', text: '기록' }, { kind: 'peace' }] },
      { ...preview(), fromCityCount: -1 },
      { ...preview(), fromCityCount: NaN },
      { ...preview(), target: { relation: 'NONE', cityCount: -1 } },
      { ...preview(), target: { relation: 'UNKNOWN', cityCount: 1 } },
      { ...preview(), fromNationId: 0 },
      { ...preview(), toNationId: 0 },
    ])
      expect(() => Reflect.apply(quoteTreatyProposal, undefined, [invalid])).toThrow();
  });
});
