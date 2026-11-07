import { describe, expect, it } from 'vitest';
import type { Rng } from '@opensamguk/shared';
import { commandInitial, commandWorld } from '../../test/commandFixture';
import { applyEffects } from '../commands/effects';
import { cloneWorld } from '../model/clone';
import { initialReplayState } from '../replay';
import { checkReplayOrigin, checkRuleFeatures } from '../ruleRegistry';
import { resolverForRuleFeatures } from '../ruleCommands';
import { initialPreparedTurns } from '../preparedTurns/state';
import { initialNationResearch, readNationResearch } from './state';
import { readStoredNationResearch } from './origin';
import { canExecuteResearchNationCommand } from './commands';

const features = ['nation-research-v1', 'personnel', 'prepared-turns-v1'];
const actor = { generalId: 1, target: 'nation' as const, authority: 'office' as const, tick: 0 };
const noRng: Rng = {
  next() {
    throw new Error('연구는 난수를 쓰지 않습니다.');
  },
  int() {
    throw new Error('연구는 난수를 쓰지 않습니다.');
  },
  pick() {
    throw new Error('연구는 난수를 쓰지 않습니다.');
  },
};
function world() {
  const state = commandWorld();
  state.ruleFeatures = [...features];
  state.preparedTurns = initialPreparedTurns();
  state.nationResearch = initialNationResearch();
  return state;
}
function run(key: string, state = world()) {
  return resolverForRuleFeatures(state)!.run(state, actor, key, {}, noRng);
}

describe('AC-P2-06 D-077 특수 병종 연구 7종', () => {
  it.each([
    ['greatsword', 12, 50_000, 60],
    ['fire_arrow', 12, 50_000, 60],
    ['mountain', 12, 50_000, 60],
    ['halberd', 24, 100_000, 120],
    ['repeater', 24, 100_000, 120],
    ['elephant', 24, 100_000, 120],
    ['fire_wheel', 24, 100_000, 120],
  ] as const)('%s는 %i번째에 국고 비용과 보상을 한 번 적용한다', (name, turns, cost, reward) => {
    let state = world();
    const initial = cloneWorld(state);
    const key = `nation_research_${name}`;
    for (let turn = 1; turn <= turns; turn++) {
      const before = structuredClone(state);
      const result = run(key, state);
      expect(state).toEqual(before);
      if ('code' in result) throw new Error(result.message);
      state = applyEffects(state, result.effects);
      expect(state.generals[1]!.gold).toBe(initial.generals[1]!.gold);
      expect(state.generals[1]!.rice).toBe(initial.generals[1]!.rice);
      if (turn < turns) {
        expect(state.nations[1]).toEqual(initial.nations[1]);
        expect(state.generals[1]).toEqual(initial.generals[1]);
        expect(state.nationResearch!.nations).toEqual({});
        expect(state.preparedTurns!.nations[1]![12]!.term).toBe(turn);
        expect(result.logs[0]!.text).toContain(`(${turn}/${turns})`);
      } else {
        expect(state.nations[1]!.gold).toBe(initial.nations[1]!.gold - cost);
        expect(state.nations[1]!.rice).toBe(initial.nations[1]!.rice - cost);
        expect(state.generals[1]!.experience).toBe(initial.generals[1]!.experience + reward);
        expect(state.generals[1]!.dedication).toBe(initial.generals[1]!.dedication + reward);
        expect(state.nationResearch!.nations).toEqual({ 1: [name] });
        expect(state.preparedTurns!.nations).toEqual({});
        expect(result.history).toHaveLength(1);
      }
    }
    const completed = structuredClone(state);
    expect(run(key, state)).toMatchObject({ code: 'BAD_STATE' });
    expect(state).toEqual(completed);
  });

  it.each([0, 1, 4, 5, 10, 11, 12, 13, 5.5])('직책 %s의 경계를 비용과 준비 진행 전에 검사한다', (level) => {
    const state = world();
    state.generals[1]!.officerLevel = level;
    const allowed = Number.isInteger(level) && level >= 5 && level <= 12;
    expect(canExecuteResearchNationCommand(state, level, 'nation_research_greatsword')).toBe(allowed);
    const result = run('nation_research_greatsword', state);
    expect('effects' in result).toBe(allowed);
    if (!allowed) expect(result).toMatchObject({ code: 'NOT_RULER' });
    expect(state.preparedTurns!.nations).toEqual({});
  });

  it('완료 직전 자원 부족은 진행을 보존하고 다른 직책의 완료 뒤에는 다시 지출하지 않는다', () => {
    const state = world();
    const key = 'nation_research_greatsword';
    state.preparedTurns!.nations[1] = {
      5: { commandKey: key, args: {}, term: 11 },
      12: { commandKey: key, args: {}, term: 11 },
    };
    state.nations[1]!.gold = 49_999;
    const before = structuredClone(state);
    expect(run(key, state)).toMatchObject({ code: 'NO_GOLD' });
    expect(state).toEqual(before);
    state.nations[1]!.gold = 50_000;
    const result = run(key, state);
    if ('code' in result) throw new Error(result.message);
    const next = applyEffects(state, result.effects);
    expect(next.preparedTurns!.nations[1]).toEqual({ 5: { commandKey: key, args: {}, term: 11 } });
    next.generals[1]!.officerLevel = 5;
    const completed = structuredClone(next);
    expect(run(key, next)).toMatchObject({ code: 'BAD_STATE' });
    expect(next).toEqual(completed);
  });

  it('도시 소유와 국가 소속을 실제 실행 때 다시 검사한다', () => {
    const state = world();
    state.cities[state.generals[1]!.cityKey]!.nationId = 2;
    expect(run('nation_research_greatsword', state)).toMatchObject({ code: 'NOT_OWN_CITY' });
    state.generals[1]!.nationId = null;
    expect(run('nation_research_greatsword', state)).toMatchObject({ code: 'NOT_NATION' });
  });

  it('생성·저장·복제는 새 두 상태를 보존하며 옛 월드와 잘못된 판에는 켜지지 않는다', () => {
    const initial = commandInitial();
    expect(initialReplayState(initial).state).not.toHaveProperty('nationResearch');
    expect(initialReplayState(initial).state).not.toHaveProperty('preparedTurns');
    initial.ruleFeatures = [...features];
    for (const general of initial.generals) general.userId = null;
    const origin = { version: 3 as const, initial, initialStateHash: 'checked', resourceHash: 'checked' };
    expect(() => checkReplayOrigin(origin)).toThrow('연구 조건');
    initial.unitSet.crewTypes[1]!.requirements = [{ kind: 'research', name: 'greatsword' }];
    expect(() => checkReplayOrigin(origin)).not.toThrow();
    const replay = initialReplayState(initial);
    expect(replay.state.preparedTurns).toEqual(initialPreparedTurns());
    expect(replay.state.nationResearch).toEqual(initialNationResearch());
    const stored = {
      ruleFeatures: features,
      replayFormat: 3,
      replayOrigin: origin,
      nationResearchState: initialNationResearch(),
    };
    expect(readStoredNationResearch(stored)).toEqual(initialNationResearch());
    expect(() => readStoredNationResearch({ ...stored, nationResearchState: null })).toThrow();
    expect(() => readStoredNationResearch({ ...stored, replayFormat: 1 })).toThrow();
    expect(() => checkRuleFeatures(['nation-research-v1', 'personnel'])).toThrow();
    expect(() => readNationResearch({ version: 1, nations: { 999: ['repeater', 'greatsword'] } }, world())).toThrow();
    expect(
      readNationResearch({ version: 1, nations: { 999: ['greatsword', 'repeater'] } }, world())?.nations[999],
    ).toEqual(['greatsword', 'repeater']);
    const old = commandWorld();
    expect(canExecuteResearchNationCommand(old, 12, 'nation_research_greatsword')).toBe(false);
    expect(readNationResearch(null, old)).toBeUndefined();
    expect(() => readNationResearch(initialNationResearch(), old)).toThrow();
  });
});
