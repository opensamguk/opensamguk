import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { cloneWorld } from '../model/clone';
import { advancePrepare, initialPreparedTurns, readPreparedTurns, type PrepareRecord } from './state';
import { trackNationTurn } from './withPrepare';

describe('AC-P2-05 국가 직책의 연속 준비', () => {
  it('객체 키 순서가 달라도 이어지고 배열 순서·명령·인자가 바뀌면 다시 센다', () => {
    const record: PrepareRecord = { commandKey: 'research', args: { a: [1, 2], b: { x: true } }, term: 2 };
    expect(advancePrepare(record, 'research', { b: { x: true }, a: [1, 2] }, 3)).toEqual({
      phase: 'prepare',
      record: { ...record, term: 3 },
    });
    expect(advancePrepare({ ...record, term: 3 }, 'research', record.args, 3)).toEqual({ phase: 'execute' });
    for (const [key, args] of [
      ['other', record.args],
      ['research', { a: [2, 1], b: { x: true } }],
      ['research', {}],
    ] as const)
      expect(advancePrepare(record, key, args, 3)).toMatchObject({
        phase: 'prepare',
        record: { commandKey: key, term: 1 },
      });
  });

  it.each([1, 11, 23])('준비 %i회 뒤 다음 실행에서만 효과 단계가 된다', (prepare) => {
    let record: PrepareRecord | undefined;
    for (let term = 1; term <= prepare; term++) {
      const next = advancePrepare(record, 'research', {}, prepare);
      expect(next.phase).toBe('prepare');
      if (next.phase !== 'prepare') throw new Error('준비 횟수가 부족합니다.');
      record = next.record;
      expect(record.term).toBe(term);
    }
    expect(advancePrepare(record, 'research', {}, prepare)).toEqual({ phase: 'execute' });
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER])('저장할 수 없는 준비 기간 %s를 거부한다', (prepare) => {
    expect(() => advancePrepare(undefined, 'research', {}, prepare)).toThrow();
  });

  it.each([-0, NaN, Infinity, undefined, '\u0000', '\ud800', { value: '\udfff' }, { value: -0 }])(
    '저장 불가능한 인자 %#를 거부한다',
    (args) => {
      expect(() => advancePrepare(undefined, 'research', args, 1)).toThrow();
    },
  );

  it('꺼진 월드는 같은 객체를 보존하며 실패·다른 직책·사라진 국가 기록을 구분한다', () => {
    const state = commandWorld();
    const success = { effects: [], logs: [] };
    expect(trackNationTurn(state, { nationId: 1, officerLevel: 12 }, 'nation_rest', success)).toBe(state);
    expect(state).not.toHaveProperty('preparedTurns');
    state.ruleFeatures = ['personnel', 'prepared-turns-v1'];
    state.preparedTurns = initialPreparedTurns();
    const record = { commandKey: 'research', args: {}, term: 11 };
    state.preparedTurns.nations = { 1: { 5: { ...record }, 12: { ...record } }, 999: { 5: { ...record } } };
    expect(
      trackNationTurn(state, { nationId: 1, officerLevel: 5 }, 'other', { code: 'NO_GOLD', message: '부족' }),
    ).toBe(state);
    expect(state.preparedTurns.nations[1]![5]).toEqual(record);
    trackNationTurn(state, { nationId: 1, officerLevel: 5 }, 'nation_rest', success);
    expect(state.preparedTurns.nations[1]).toEqual({ 12: record });
    expect(readPreparedTurns(state.preparedTurns, state)?.nations[999]).toEqual({ 5: record });
    trackNationTurn(state, { nationId: 1, officerLevel: 12 }, 'nation_rest', success);
    expect(state.preparedTurns.nations).not.toHaveProperty('1');
    const copied = cloneWorld(state);
    copied.preparedTurns!.nations[999]![5]!.term = 2;
    expect(state.preparedTurns.nations[999]![5]!.term).toBe(11);
    expect(() => readPreparedTurns(state.preparedTurns, {})).toThrow();
    expect(() => readPreparedTurns(null, state)).toThrow();
  });
});
