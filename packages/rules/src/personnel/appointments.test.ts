import { describe, expect, it } from 'vitest';
import { appointOfficer, dismissOfficer } from './appointments';
import { APPOINTABLE_OFFICER_LEVELS } from './permissions';
import { applied, deepFreeze, personnelWorld } from './testFixture';
import type { PersonnelState } from './types';

describe('인사 임명·해임 순수 규칙', () => {
  it.each(APPOINTABLE_OFFICER_LEVELS)('군주는 빈 직책 %i에 소속 장수를 임명한다', (level) => {
    const before = personnelWorld();
    before.generals[4]!.officerLevel = 1;
    const outcome = applied(appointOfficer(deepFreeze(before), 1, 3, level));
    expect(outcome.result).toEqual({ generalId: 3, officerLevel: level, title: level === 11 ? '참모' : '수뇌' });
    expect(outcome.state.generals[3]!.officerLevel).toBe(level);
    expect(before.generals[3]!.officerLevel).toBe(1);
    expect(outcome.state.generals[3]).toEqual({ ...before.generals[3], officerLevel: level });
    expect(outcome.logs).toEqual([
      { generalId: 3, commandKey: 'personnel.appoint', kind: 'success', text: `장수3 ${outcome.result.title} 임명` },
    ]);
    expect(outcome.closedOffers).toEqual([]);
    expect(Object.hasOwn(outcome.state, 'assignmentOffers')).toBe(false);
  });

  it.each([0, 1, 5, 6, 7, 8, 9, 10, 11])('직책 %i는 임명·해임을 할 수 없다', (level) => {
    const state = personnelWorld();
    state.generals[1]!.officerLevel = level;
    expect(appointOfficer(state, 1, 3, 11)).toMatchObject({ ok: false, code: 'NOT_RULER' });
    expect(dismissOfficer(state, 1, 4)).toMatchObject({ ok: false, code: 'NOT_RULER' });
  });

  it.each([0, 1, 2, 3, 4, 12, 13, -1, 5.5, NaN, Infinity])('임명 대상 직책 %s를 거부한다', (level) => {
    expect(appointOfficer(personnelWorld(), 1, 3, level)).toMatchObject({ ok: false, code: 'BAD_ARGS' });
  });

  const invalidActors: [string, (state: PersonnelState) => void, string][] = [
    [
      '없는 행위자',
      (s) => {
        delete s.generals[1];
      },
      'NO_ACTOR',
    ],
    [
      '재야 행위자',
      (s) => {
        s.generals[1]!.nationId = null;
      },
      'NOT_NATION',
    ],
    [
      '없는 국가',
      (s) => {
        delete s.nations[1];
      },
      'NOT_NATION',
    ],
  ];
  it.each(invalidActors)('%s의 요청을 거부한다', (_name, prepare, code) => {
    const state = personnelWorld();
    prepare(state);
    const snapshot = structuredClone(state);
    expect(appointOfficer(deepFreeze(state), 1, 3, 11)).toMatchObject({ ok: false, code });
    expect(dismissOfficer(state, 1, 4)).toMatchObject({ ok: false, code });
    expect(state).toEqual(snapshot);
  });

  it.each([1, 2, 999])('군주·타국·없는 장수 %i의 직책을 바꾸지 않는다', (targetId) => {
    const state = deepFreeze(personnelWorld());
    expect(appointOfficer(state, 1, targetId, 11)).toMatchObject({ ok: false, code: 'BAD_TARGET' });
    expect(dismissOfficer(state, 1, targetId)).toMatchObject({ ok: false, code: 'BAD_TARGET' });
  });

  it('자리가 차 있으면 같은 사람의 재임명도 먼저 해임하도록 거부한다', () => {
    const state = personnelWorld();
    expect(appointOfficer(state, 1, 3, 5)).toEqual({ ok: false, code: 'BAD_STATE', message: '먼저 해임하세요' });
    expect(appointOfficer(state, 1, 4, 5)).toEqual({ ok: false, code: 'BAD_STATE', message: '먼저 해임하세요' });
  });

  it('다른 국가의 같은 직책은 임명을 막지 않는다', () => {
    const state = personnelWorld();
    state.generals[2]!.officerLevel = 11;
    expect(applied(appointOfficer(state, 1, 3, 11)).state.generals[3]!.officerLevel).toBe(11);
  });

  it('직책을 옮기면 원래 직책을 비우고 다른 장수를 임명할 수 있다', () => {
    const promoted = applied(appointOfficer(deepFreeze(personnelWorld()), 1, 4, 11));
    const next = applied(appointOfficer(deepFreeze(promoted.state), 1, 3, 5));
    expect(next.state.generals[4]!.officerLevel).toBe(11);
    expect(next.state.generals[3]!.officerLevel).toBe(5);
  });

  it.each(APPOINTABLE_OFFICER_LEVELS)('직책 %i를 해임하면 일반 장수로 돌아간다', (level) => {
    const state = personnelWorld();
    state.generals[4]!.officerLevel = level;
    const outcome = applied(dismissOfficer(deepFreeze(state), 1, 4));
    expect(outcome.result).toEqual({ generalId: 4, officerLevel: 1, title: '장수' });
    expect(outcome.state.generals[4]).toEqual({ ...state.generals[4], officerLevel: 1 });
    expect(outcome.logs).toHaveLength(1);
    expect(state.generals[4]!.officerLevel).toBe(level);
    expect(dismissOfficer(outcome.state, 1, 4)).toMatchObject({ ok: false, code: 'BAD_TARGET' });
  });

  it('대상 재야 장수를 임명·해임할 수 없다', () => {
    const state = personnelWorld();
    state.generals[3]!.nationId = null;
    expect(appointOfficer(state, 1, 3, 11)).toMatchObject({ ok: false, code: 'BAD_TARGET' });
    expect(dismissOfficer(state, 1, 3)).toMatchObject({ ok: false, code: 'BAD_TARGET' });
  });

  it('임명과 해임이 대기 중 제안이나 기존 명령 상태를 떨어뜨리지 않는다', () => {
    const state = personnelWorld();
    state.assignmentOffers = {
      3: { id: '0-4-3', nationId: 1, issuerGeneralId: 4, cityKey: 4, createdTick: 0, expiresTick: 20000 },
    };
    state.commandMeta = { nextNationId: 3, offers: { 9: 1 } };
    state.nationTurns = { 1: [{ commandKey: 'nation_rest', args: { nested: [1] } }] };
    const next = applied(dismissOfficer(applied(appointOfficer(deepFreeze(state), 1, 3, 11)).state, 1, 4));
    expect(next.state.assignmentOffers).toEqual(state.assignmentOffers);
    expect(next.state.commandMeta).toEqual(state.commandMeta);
    expect(next.state.nationTurns).toEqual(state.nationTurns);
    next.state.assignmentOffers![3]!.cityKey = 1;
    expect(state.assignmentOffers[3]!.cityKey).toBe(4);
  });
});
