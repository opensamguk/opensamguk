import { describe, expect, it } from 'vitest';
import type { Rng } from '@opensamguk/shared';
import { commandInitial, commandWorld } from '../../test/commandFixture';
import { TICKS_PER_MONTH } from '../clock/constants';
import { applyEffects } from '../commands/effects';
import { cloneWorld } from '../model/clone';
import { settleDiplomacy } from '../monthly';
import { resolverForRuleFeatures } from '../ruleCommands';
import { initialReplayState } from '../replay';
import { checkReplayOrigin } from '../ruleRegistry';
import { initialStratagemCards } from '../stratagemCards/state';
import { readStratagemCardsConfig } from '../stratagemCards/feature';
import { TEST_STRATAGEM_CARDS_CONFIG } from '../stratagemCards/testFixture';
import { readStoredNationStrategy } from './origin';
import { initialNationStrategy, readNationStrategy } from './state';

const actor = { generalId: 1, target: 'nation' as const, authority: 'office' as const, tick: 0 };
const noRng: Rng = {
  next() {
    throw new Error('전략 명령은 난수를 쓰지 않습니다.');
  },
  int() {
    throw new Error('전략 명령은 난수를 쓰지 않습니다.');
  },
  pick() {
    throw new Error('전략 명령은 난수를 쓰지 않습니다.');
  },
};
function world() {
  const state = commandWorld();
  state.ruleFeatures = ['nation-strategy-v1', 'personnel'];
  state.nationStrategy = initialNationStrategy();
  return state;
}
function run(key: string, args: unknown, state = world(), tick = 0) {
  return resolverForRuleFeatures(state)!.run(state, { ...actor, tick }, key, args, noRng);
}
function execute(key: string, args: unknown, state = world(), tick = 0) {
  const result = run(key, args, state, tick);
  if ('code' in result) throw new Error(result.message);
  return { result, state: applyEffects(state, result.effects) };
}

describe('AC-P2-04 D-074 전략 3종', () => {
  it('최초 상태는 비어 있고 기능을 끈 생성과 clone에는 새 키가 없다', () => {
    const initial = commandInitial();
    expect(initialReplayState(initial).state).not.toHaveProperty('nationStrategy');
    initial.ruleFeatures = ['nation-strategy-v1', 'personnel'];
    for (const general of initial.generals) general.userId = null;
    const origin = { version: 3 as const, initial, initialStateHash: 'checked', resourceHash: 'checked' };
    expect(() => checkReplayOrigin(origin)).not.toThrow();
    expect(initialReplayState(initial).state.nationStrategy).toEqual(initialNationStrategy());
    const stored = {
      ruleFeatures: initial.ruleFeatures,
      replayFormat: 3,
      replayOrigin: origin,
      nationStrategyState: initialNationStrategy(),
    };
    expect(readStoredNationStrategy(stored)).toEqual(initialNationStrategy());
    expect(() => readStoredNationStrategy({ ...stored, nationStrategyState: null })).toThrow();
    expect(() => readStoredNationStrategy({ ...stored, replayFormat: 1 })).toThrow();
    expect(() => readStoredNationStrategy({ ...stored, ruleFeatures: ['personnel'] })).toThrow();
    expect(readNationStrategy(null, {})).toBeUndefined();
    expect(() =>
      readNationStrategy({ version: 1, nations: { '01': { strategicUntil: 1, commands: {} } } }, world()),
    ).toThrow();
    expect(() =>
      checkReplayOrigin({ ...origin, initial: { ...initial, nationStrategy: initialNationStrategy() } }),
    ).toThrow();
    const source = world();
    const copy = cloneWorld(source);
    copy.nationStrategy!.nations[1] = { strategicUntil: 9, commands: { nation_mobilize: 63 } };
    expect(source.nationStrategy!.nations).toEqual({});
  });

  it.each([0, 1, 4, 5, 10, 11, 12, 13, 5.5])('직책 %s의 권한을 효과·카드 소모 전에 검사한다', (level) => {
    for (const key of ['nation_mobilize', 'nation_rivalry', 'nation_raid']) {
      const state = world();
      state.generals[1]!.officerLevel = level;
      state.diplomacies[0] = { nationA: 1, nationB: 2, state: 'DECLARED', untilTick: TICKS_PER_MONTH };
      const result = run(key, key === 'nation_mobilize' ? { cityKey: 1 } : { nationId: 2 }, state);
      const allowed = Number.isInteger(level) && level <= 12 && level >= (key === 'nation_mobilize' ? 5 : 11);
      expect('effects' in result).toBe(allowed);
      if (!allowed) expect(result).toMatchObject({ code: 'NOT_RULER' });
    }
  });

  it('백성동원은 최대 80%까지 보강하며 현재값·공헌·비용·로그를 결정적으로 보존한다', () => {
    const state = world();
    state.cities[1]!.supplied = false;
    Object.assign(state.cities[1]!, { defence: 1, defenceMax: 1001, wall: 950, wallMax: 1000 });
    const before = structuredClone(state);
    const first = execute('nation_mobilize', { cityKey: 1 }, state);
    expect(first).toEqual(execute('nation_mobilize', { cityKey: 1 }, state));
    expect(first.state.cities[1]).toMatchObject({ defence: 801, wall: 950 });
    expect(first.state.generals[1]!.experience).toBe(state.generals[1]!.experience + 5);
    expect(first.state.generals[1]!.dedication).toBe(state.generals[1]!.dedication + 5);
    expect(first.state.generals[1]!.gold).toBe(state.generals[1]!.gold);
    expect(first.result.reports).toBeUndefined();
    expect(first.result.history).toHaveLength(1);
    expect(state).toEqual(before);
  });

  it('공통 9개월과 개별 63개월 대기를 각각 검사하고 만료 시점부터 허용한다', () => {
    const state = execute('nation_mobilize', { cityKey: 1 }).state;
    expect(state.nationStrategy!.nations[1]).toEqual({ strategicUntil: 9, commands: { nation_mobilize: 63 } });
    expect(run('nation_rivalry', { nationId: 2 }, state, 9 * TICKS_PER_MONTH - 1)).toMatchObject({
      code: 'BAD_STATE',
      message: '전략 기한이 남았습니다.',
    });
    expect(run('nation_rivalry', { nationId: 2 }, state, 9 * TICKS_PER_MONTH)).toHaveProperty('effects');
    expect(run('nation_mobilize', { cityKey: 1 }, state, 62 * TICKS_PER_MONTH)).toMatchObject({
      code: 'BAD_STATE',
      message: '1개월 더 기다려야 합니다.',
    });
    expect(run('nation_mobilize', { cityKey: 1 }, state, 63 * TICKS_PER_MONTH)).toHaveProperty('effects');
  });

  it('등장 전·퇴장·타국 장수는 대기에 세지 않고 등장한 40명은 126개월을 적용한다', () => {
    const state = world();
    for (let id = 10; id < 50; id++)
      state.generals[id] = { ...state.generals[1]!, id, activeFromYear: state.startYear + 1 };
    expect(
      execute('nation_mobilize', { cityKey: 1 }, state).state.nationStrategy!.nations[1]!.commands.nation_mobilize,
    ).toBe(63);
    for (let id = 10; id < 50; id++) state.generals[id]!.activeFromYear = state.startYear;
    for (const id of [1, 3]) state.generals[id]!.removedAt = 0;
    const next = resolverForRuleFeatures(state)!.run(
      state,
      { ...actor, generalId: 10 },
      'nation_mobilize',
      { cityKey: 1 },
      noRng,
    );
    if ('code' in next) throw new Error(next.message);
    expect(applyEffects(state, next.effects).nationStrategy!.nations[1]!.commands.nation_mobilize).toBe(126);
  });

  it('이호경식은 전쟁을 1개월 선포로 바꾸고 기존 선포는 1개월 늘린다', () => {
    const first = execute('nation_rivalry', { nationId: 2 }, world(), 321);
    expect(first.state.diplomacies[0]).toMatchObject({ state: 'DECLARED', untilTick: 10321 });
    expect(first.state.nationStrategy!.nations[1]!.commands.nation_rivalry).toBe(126);
    expect(first.result.history?.map((row) => row.nationId)).toEqual([1, 2]);
    expect(first.result.reports).toBeUndefined();
    const state = world();
    Object.assign(state.diplomacies[0]!, { state: 'DECLARED', untilTick: 20000 });
    expect(execute('nation_rivalry', { nationId: 2 }, state, 321).state.diplomacies[0]!.untilTick).toBe(30000);
  });

  it('급습은 남은 1개월 경계를 검사하고 다음 월 정산에 전쟁이 시작된다', () => {
    const state = world();
    Object.assign(state.diplomacies[0]!, { state: 'DECLARED', untilTick: 20000 });
    expect(run('nation_raid', { nationId: 2 }, state, 10001)).toMatchObject({ code: 'NOT_WAR' });
    const next = execute('nation_raid', { nationId: 2 }, state, 10000).state;
    expect(next.diplomacies[0]).toMatchObject({ state: 'DECLARED', untilTick: 10000 });
    expect(settleDiplomacy(next, 10000).diplomacies[0]!.state).toBe('WAR');
  });

  it('타국·자기 국가·공백지·잘못된 인자를 거부하고 꺼진 월드에는 명령을 등록하지 않는다', () => {
    expect(run('nation_mobilize', { cityKey: 2 })).toMatchObject({ code: 'BAD_TARGET' });
    expect(run('nation_rivalry', { nationId: 1 })).toMatchObject({ code: 'BAD_TARGET' });
    expect(run('nation_raid', { nationId: 999 })).toMatchObject({ code: 'BAD_TARGET' });
    expect(run('nation_mobilize', { cityKey: 1, other: true })).toMatchObject({ code: 'BAD_ARGS' });
    const state = world();
    state.ruleFeatures = ['personnel'];
    delete state.nationStrategy;
    expect(resolverForRuleFeatures(world())!.run(state, actor, 'nation_mobilize', { cityKey: 1 }, noRng)).toMatchObject(
      { code: 'COMMAND_DISABLED' },
    );
    expect(resolverForRuleFeatures(state)?.get('nation_mobilize')).toBeUndefined();
  });

  it('전략 기능 없는 덱은 거부하고 예약은 패 없이 허용하되 성공한 국가 전략은 한 장만 쓴다', () => {
    const state = world();
    state.ruleFeatures = ['five-stats', 'nation-strategy-v1', 'personnel', 'stratagem-basic', 'stratagem-cards-v1'];
    const config = { ...TEST_STRATAGEM_CARDS_CONFIG, deck: [{ kind: 'nation_mobilize' as const, weight: 1 }] };
    expect(() => readStratagemCardsConfig({ version: 1, config })).toThrow('전략 기능');
    expect(readStratagemCardsConfig({ version: 1, config }, state.ruleFeatures)).toEqual(config);
    state.stratagemCards = initialStratagemCards(config, state, 'strategy-cards');
    const resolver = resolverForRuleFeatures(state)!;
    expect(resolver.precheck(state, actor, 'nation_mobilize', { cityKey: 1 })).toBeNull();
    expect(resolver.run(state, actor, 'nation_mobilize', { cityKey: 1 }, noRng)).toMatchObject({
      code: 'NO_SCHEME_CARD',
    });
    state.stratagemCards.nations[1]!.hand = ['nation_mobilize', 'nation_mobilize'];
    const before = structuredClone(state);
    const next = execute('nation_mobilize', { cityKey: 1 }, state).state;
    expect(next.stratagemCards!.nations[1]!.hand).toEqual(['nation_mobilize']);
    expect(run('nation_mobilize', { cityKey: 1 }, next)).toMatchObject({ code: 'BAD_STATE' });
    expect(next.stratagemCards!.nations[1]!.hand).toEqual(['nation_mobilize']);
    expect(state).toEqual(before);
  });
});
