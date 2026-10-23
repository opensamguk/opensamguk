import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import {
  guideTreatyResponse as publicGuide,
  type TreatyResponseGuide as PublicGuide,
  type TreatyResponseGuideCode as PublicCode,
} from '../index';
import { TICKS_PER_MONTH } from '../clock/constants';
import {
  applyTreatyInput,
  calculateTreatyFee,
  guideTreatyResponse,
  TREATY_INPUTS,
  type TreatyRelation,
} from './treaty';
import type { TreatyClause } from './treatyTypes';

const clauses: TreatyClause[] = [{ kind: 'nonAggression', months: 12 }];
function proposed(input: TreatyClause[] = clauses) {
  const state = commandWorld();
  state.nations[1]!.isNpc = false;
  state.nations[2]!.isNpc = false;
  state.generals[1]!.nationId = 1;
  state.generals[1]!.officerLevel = 12;
  state.generals[2]!.nationId = 2;
  state.generals[2]!.officerLevel = 12;
  state.diplomacies = input.some((c) => c.kind === 'peace')
    ? [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 90000 }]
    : [];
  const result = applyTreatyInput(
    state,
    {
      generalId: 1,
      kind: 'treaty.propose',
      payload: TREATY_INPUTS['treaty.propose'].normalizePayload({ toNationId: 2, clauses: input }),
    },
    { tick: 1500, sequence: 10 },
  );
  if (!result.ok || result.result.outcome !== 'PROPOSED') throw new Error('제안 fixture 실패');
  return result.state;
}
function relation(state: ReturnType<typeof proposed>, current: TreatyRelation) {
  state.diplomacies = current === 'NONE' ? [] : [{ nationA: 1, nationB: 2, state: current, untilTick: 90000 }];
}
function guideInput(state: ReturnType<typeof proposed>, tick = 1501) {
  const treaty = state.treaties![0]!;
  const current: TreatyRelation = state.diplomacies[0]?.state ?? 'NONE';
  return {
    treaty,
    tick,
    relation: current,
    responderCityCount: Object.values(state.cities).filter((city) => city.nationId === treaty.toNationId).length,
    responderGold: state.nations[treaty.toNationId]!.gold,
  };
}
function respond(state: ReturnType<typeof proposed>, accept: boolean, tick = 1501) {
  return applyTreatyInput(
    state,
    { generalId: 2, kind: 'treaty.respond', payload: { treatyId: '10', accept } },
    { tick, sequence: 11 },
  );
}
function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe('T2-07 / AC-M2-06 첫 세 조항 응답 안내', () => {
  it('G1 응답 기한과 그 뒤에는 수락·거절 모두 실제 엔진과 같은 EXPIRED다', () => {
    const state = proposed();
    relation(state, 'NON_AGGRESSION');
    state.nations[2]!.gold = 0;
    for (const tick of [state.treaties![0]!.respondByTick, state.treaties![0]!.respondByTick + 1]) {
      const guide = guideTreatyResponse(guideInput(state, tick));
      for (const accept of [true, false]) {
        const engine = respond(state, accept, tick);
        if (engine.ok) throw new Error('기한 fixture 실패');
        expect(engine.result.code).toBe('EXPIRED');
        expect(accept ? guide.accept : guide.reject).toEqual({
          code: engine.result.code,
          message: engine.result.message,
        });
      }
    }
  });

  it('G2 기한 안의 거절은 관계 불허와 빈 국고에서도 허용된다', () => {
    const state = proposed();
    state.nations[2]!.gold = 0;
    relation(state, 'NON_AGGRESSION');
    expect(guideTreatyResponse(guideInput(state))).toMatchObject({ accept: { code: 'TREATY_RELATION' }, reject: null });
    expect(respond(state, false)).toMatchObject({ ok: true, result: { outcome: 'DECLINED' } });
    relation(state, 'NONE');
    expect(guideTreatyResponse(guideInput(state))).toMatchObject({
      accept: { code: 'INSUFFICIENT_GOLD' },
      reject: null,
    });
    expect(respond(state, false)).toMatchObject({ ok: true, result: { outcome: 'DECLINED' } });
  });

  it('G3 네 관계와 첫 세 조항 조합의 수락 안내는 실제 관계 판정과 같다', () => {
    const combinations: TreatyClause[][] = [
      [{ kind: 'peace' }],
      clauses,
      [{ kind: 'note', text: '기록' }],
      [{ kind: 'peace' }, ...clauses],
      [{ kind: 'peace' }, { kind: 'note', text: '기록' }],
      [...clauses, { kind: 'note', text: '기록' }],
      [{ kind: 'peace' }, ...clauses, { kind: 'note', text: '기록' }],
    ];
    for (const current of ['NONE', 'WAR', 'DECLARED', 'NON_AGGRESSION'] as const)
      for (const input of combinations) {
        const state = proposed(input);
        relation(state, current);
        const engine = respond(state, true);
        const guide = guideTreatyResponse(guideInput(state));
        expect(guide.reject).toBeNull();
        if (engine.ok) {
          expect(engine.result.outcome).toBe('ACCEPTED');
          expect(guide.accept).toBeNull();
        } else {
          expect(engine.result.code).toBe('TREATY_RELATION');
          expect(guide.accept).toEqual({ code: engine.result.code, message: engine.result.message });
        }
      }
  });

  it('G4 자기 비용 경계는 엔진과 같고 제안국이 낼 수 있는지는 알려 주지 않는다', () => {
    const state = proposed();
    const cost = calculateTreatyFee(guideInput(state).responderCityCount, 12);
    state.nations[2]!.gold = cost - 1;
    const insufficient = respond(state, true);
    if (insufficient.ok) throw new Error('국고 fixture 실패');
    expect(insufficient.result.code).toBe('INSUFFICIENT_GOLD');
    expect(guideTreatyResponse(guideInput(state))).toEqual({
      accept: { code: insufficient.result.code, message: insufficient.result.message },
      reject: null,
    });
    state.nations[2]!.gold = cost;
    expect(guideTreatyResponse(guideInput(state))).toEqual({ accept: null, reject: null });
    expect(respond(state, true)).toMatchObject({ ok: true, result: { outcome: 'ACCEPTED' } });
    state.nations[1]!.gold = 0;
    expect(guideTreatyResponse(guideInput(state))).toEqual({ accept: null, reject: null });
    expect(respond(state, true)).toMatchObject({ ok: false, result: { code: 'COUNTERPART_UNAVAILABLE' } });
    const free = proposed([{ kind: 'note', text: '기록' }]);
    free.nations[2]!.gold = 0;
    expect(guideTreatyResponse(guideInput(free))).toEqual({ accept: null, reject: null });
    expect(respond(free, true)).toMatchObject({ ok: true, result: { outcome: 'ACCEPTED', cost: { from: 0, to: 0 } } });
  });

  it('G5 잘못된 상태·tick·수치·관계는 throw하며 입력과 공개 export를 보존한다', () => {
    const state = proposed();
    const input = freeze(guideInput(state));
    const before = structuredClone(input);
    expect(publicGuide).toBe(guideTreatyResponse);
    const result: PublicGuide = publicGuide(input);
    const code: PublicCode = 'EXPIRED';
    expect(result).toEqual({ accept: null, reject: null });
    expect(guideTreatyResponse({ ...input, tick: input.treaty.respondByTick }).accept?.code).toBe(code);
    expect(input).toEqual(before);
    const accepted = respond(state, true);
    if (!accepted.ok) throw new Error('수락 fixture 실패');
    const maxTick = 2147483647 - TICKS_PER_MONTH;
    for (const invalid of [
      { ...input, treaty: accepted.state.treaties![0] },
      { ...input, treaty: { ...input.treaty, respondByTick: input.treaty.respondByTick + 1 } },
      ...[-1, maxTick + 1, 1.5, NaN].map((tick) => ({ ...input, tick })),
      { ...input, responderCityCount: -1 },
      { ...input, responderCityCount: NaN },
      { ...input, responderGold: -1 },
      { ...input, responderGold: Infinity },
      { ...input, relation: 'UNKNOWN' },
    ])
      expect(() => Reflect.apply(guideTreatyResponse, undefined, [invalid])).toThrow();
    expect(guideTreatyResponse({ ...input, tick: 0 })).toEqual({ accept: null, reject: null });
    expect(guideTreatyResponse({ ...input, tick: maxTick })).toMatchObject({
      accept: { code: 'EXPIRED' },
      reject: { code: 'EXPIRED' },
    });
  });
});
