// 제품 프리셋의 비활성 상태를 시험에서 읽는다. 게임 규칙은 파일을 읽지 않는다.
// eslint-disable-next-line no-restricted-imports
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRng } from '@opensamguk/shared';
import { commandInitial, commandWorld, testUnits } from '../../../../test/commandFixture';
import { TICKS_PER_MONTH } from '../../../clock/constants';
import { cloneWorld } from '../../../model/clone';
import { toWorldState } from '../../../model/world';
import { initialReplayState, nextGameAction, runReplayAction, type ReplayState } from '../../../replay';
import { parsePreset } from '../../../world/preset';
import { applyEffects } from '../../effects';
import { createCommandResolver, createCommandResolverWithCommands } from '../../resolve';
import { runGeneralTurn } from '../../turn';
import { resolverForRuleFeatures } from '../../../ruleCommands';
import { createExtState } from '../state';
import { checkStratagem, stratagemArgs } from './base';
import { fireAttackSpec } from './fire_attack';
import { inciteSpec } from './incite';
import { stratagemCommands } from './index';
import { plunderSpec } from './plunder';
import { sabotageSpec } from './sabotage';

const enabled = { general: ['fire_attack', 'sabotage', 'incite', 'plunder'], nation: [] };
const active = createCommandResolver(enabled);
const disabled = createCommandResolver(null);
const injected = createCommandResolverWithCommands(enabled, stratagemCommands);
const actor = { generalId: 1, tick: 0 };
const args = { cityKey: 2 };
function world() {
  const state = commandWorld();
  for (const general of Object.values(state.generals)) if (general.id !== 1) general.cityKey = 3;
  Object.assign(state.cities[2]!, {
    agriculture: 900,
    commerce: 800,
    defence: 700,
    wall: 600,
    security: 500,
    level: 4,
  });
  return state;
}

describe.each(stratagemCommands)('$key registration', (def) => {
  it('keeps disabled run and precheck distinct from unknown keys without consuming RNG', () => {
    const rng = createRng('disabled');
    expect(disabled.get(def.key)).toBeUndefined();
    expect(disabled.precheck(world(), actor, def.key, args)).toMatchObject({ code: 'COMMAND_DISABLED' });
    expect(disabled.run(world(), actor, def.key, args, rng)).toMatchObject({ code: 'COMMAND_DISABLED' });
    expect(disabled.run(world(), actor, 'unregistered_stratagem', args, rng)).toMatchObject({
      code: 'UNKNOWN_COMMAND',
    });
    expect(rng.next()).toBe(createRng('disabled').next());
    expect(disabled.list('general')).toHaveLength(27);
    expect(disabled.list('nation')).toHaveLength(10);
    expect(active.get(def.key)).toBe(def);
    expect(active.list('general')).toHaveLength(31);
    expect(active.run(world(), { ...actor, target: 'nation' }, def.key, args, rng)).toMatchObject({ code: 'BAD_ARGS' });
    expect(active.precheck(world(), { ...actor, target: 'nation' }, def.key, args)).toMatchObject({ code: 'BAD_ARGS' });
  });

  it.each(['success', 'probability-failure', 'precheck-failure'])('matches injected registration: %s', (scenario) => {
    const state = world();
    if (scenario === 'precheck-failure') Object.assign(state.generals[1]!, { gold: 0, rice: 0 });
    const seed = scenario === 'probability-failure' ? 'seed-1' : 'stratagem-success';
    const left = createRng(seed);
    const right = createRng(seed);
    expect(active.precheck(state, actor, def.key, args)).toStrictEqual(injected.precheck(state, actor, def.key, args));
    expect(active.run(state, actor, def.key, args, left)).toStrictEqual(
      injected.run(state, actor, def.key, args, right),
    );
    expect([left.next(), left.next(), left.next()]).toStrictEqual([right.next(), right.next(), right.next()]);
  });

  it('상시 제공 등록표의 실제 차례와 재생은 같은 상태·난수 효과를 낸다', () => {
    const initial = commandInitial();
    for (const general of initial.generals) general.crew = 0;
    initial.generals[0]!.userId = 'user';
    initial.diplomacies = [];
    initial.cities[1]!.security = 100;
    const r0 = initialReplayState(initial);
    r0.residenceAnchors = { 1: 0 };
    r0.state.stratagemCards!.nations['1']!.hand = [def.key as 'fire_attack' | 'sabotage' | 'incite' | 'plunder'];
    r0.turns[1]![0] = { commandKey: def.key, args, explicit: true };
    const before = structuredClone(r0);
    const resolver = resolverForRuleFeatures(r0.state)!;
    const turn = runGeneralTurn(
      r0.state,
      { generalId: 1, tick: 100, unitSet: testUnits },
      r0.turns[1]![0]!,
      initial.seed,
      { policy: r0.policy!.policies[1]!, turnRevision: 0 },
      resolver,
      { offices: r0.offices! },
    );
    const replay = runReplayAction(r0, initial.seed, testUnits);
    expect(nextGameAction(r0)).toEqual({ kind: 'turn', tick: 100, generalId: 1 });
    expect(turn.commandKey).toBe(def.key);
    expect(turn.result).not.toHaveProperty('code');
    const expectedState = structuredClone(turn.state);
    expectedState.generals[1]!.nextTurnTick = 100 + TICKS_PER_MONTH;
    expect(replay.state).toEqual(expectedState);
    expect(replay.revisions[1]).toBe(1);
    expect(replay.turns[1]).toHaveLength(30);
    expect(runReplayAction(r0, initial.seed, testUnits)).toEqual(replay);
    expect(r0).toEqual(before);
  });
});

it('keeps each definition paired with its unchanged spec and shared functions', () => {
  const specs = [fireAttackSpec, sabotageSpec, inciteSpec, plunderSpec];
  stratagemCommands.forEach((def, i) => {
    expect([def.key, def.name]).toStrictEqual([specs[i]!.key, specs[i]!.name]);
    expect(def.target).toBe('general');
    expect(def.category).toBe('strategy');
    expect(def.args).toBe(stratagemArgs);
    if (def.key !== 'sabotage') {
      expect(def.check).toBe(checkStratagem);
      expect(def.precheck).toBe(checkStratagem);
    }
  });
});

it('accepts general preset registration and rejects nation registration without activating product presets', () => {
  const folder = new URL('../../../../../../resources/preset/', import.meta.url);
  const files = readdirSync(folder).filter((file) => file.endsWith('.json'));
  expect(files.sort()).toStrictEqual(['beginner.json', 'empty.json', 'hardcore.json', 'regular.json', 'speed.json']);
  for (const file of files) {
    const preset = JSON.parse(readFileSync(new URL(file, folder), 'utf8')) as Record<string, unknown>;
    expect(preset.commands).toBeNull();
    expect(parsePreset({ ...preset, commands: enabled }).commands).toStrictEqual(enabled);
    for (const key of enabled.general) {
      const wrong = { general: [], nation: [key] };
      expect(() => createCommandResolver(wrong)).toThrow(key);
      expect(() => parsePreset({ ...preset, commands: wrong })).toThrow('확장 명령 설정을 확인하세요.');
    }
  }
});

it('creates no state slice and preserves ext absence through state creation, cloning and effects', () => {
  const state = world();
  expect(createExtState(enabled, state)).toBeUndefined();
  const result = active.run(state, actor, 'fire_attack', args, createRng('stratagem-success'));
  expect('code' in result).toBe(false);
  if ('code' in result) throw new Error(result.message);
  expect(Object.hasOwn(toWorldState(commandInitial()), 'ext')).toBe(false);
  for (const value of [cloneWorld(state), applyEffects(state, result.effects)]) expect(value.ext).toEqual(state.ext);
});

it('replays twelve enabled months deterministically with all required ledgers', () => {
  function replay() {
    const state = world();
    state.generals[1]!.userId = 'user';
    for (const general of Object.values(state.generals)) general.crew = 0;
    let current: ReplayState = { ...initialReplayState(commandInitial()), state, residenceAnchors: { 1: 0 } };
    current.turns[1]![0] = { commandKey: 'fire_attack', args };
    while (current.monthlyTick < 120000) {
      expect(current.state.ext).toBeDefined();
      current = runReplayAction(current, 'stratagem-replay', testUnits, active);
    }
    expect(current.state.ext).toBeDefined();
    return current;
  }
  expect(replay()).toStrictEqual(replay());
});
