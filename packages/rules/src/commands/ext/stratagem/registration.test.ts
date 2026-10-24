// 제품 프리셋의 비활성 상태를 시험에서 읽는다. 게임 규칙은 파일을 읽지 않는다.
// eslint-disable-next-line no-restricted-imports
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRng, rngFor } from '@opensamguk/shared';
import { commandInitial, commandWorld, testUnits } from '../../../../test/commandFixture';
import { TICKS_PER_MONTH } from '../../../clock/constants';
import { cloneWorld } from '../../../model/clone';
import { toWorldState } from '../../../model/world';
import { emptyTurns, nextGameAction, runReplayAction, type ReplayState } from '../../../replay';
import { parsePreset } from '../../../world/preset';
import { applyEffects } from '../../effects';
import { createCommandResolver, createCommandResolverWithCommands } from '../../resolve';
import { runGeneralTurn } from '../../turn';
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

  it.each(['enabled', 'absent', 'disabled'] as const)('matches the exact turn and replay state: %s', (mode) => {
    const state = world();
    state.generals[1]!.userId = 'user';
    const r0: ReplayState = {
      state,
      turns: Object.fromEntries([1, 2, 3, 4].map((id) => [id, emptyTurns()])),
      revisions: { 1: 0, 2: 0, 3: 0, 4: 0 },
      monthlyTick: 0,
    };
    r0.turns[1]![0] = { commandKey: def.key, args };
    const before = structuredClone(r0);
    expect(nextGameAction(r0)).toStrictEqual({ kind: 'turn', tick: 100, generalId: 1 });
    const resolver = mode === 'enabled' ? active : mode === 'disabled' ? disabled : undefined;
    const turnActor = { generalId: 1, tick: 100, unitSet: testUnits };
    const turn = runGeneralTurn(structuredClone(state), turnActor, r0.turns[1]![0]!, 'stratagem-replay', {}, resolver);
    const replay = runReplayAction(r0, 'stratagem-replay', testUnits, resolver);
    expect(turn.nation).toBeUndefined();
    expect(turn.commandKey).toBe(def.key);
    if (mode === 'enabled') {
      expect('code' in turn.result).toBe(false);
      expect(turn.result).toStrictEqual(
        active.run(
          structuredClone(state),
          { ...turnActor, target: 'general' },
          def.key,
          args,
          rngFor('stratagem-replay', 'turn', 100, 1),
        ),
      );
      expect(replay.state.generals[1]!.experience).toBeGreaterThan(0);
      expect(replay.state.generals[1]!.dedication).toBeGreaterThan(0);
    } else {
      expect(turn.result).toMatchObject({ code: mode === 'absent' ? 'UNKNOWN_COMMAND' : 'COMMAND_DISABLED' });
      expect(turn.state).toStrictEqual(state);
    }
    const expectedState = structuredClone(turn.state);
    expectedState.generals[1]!.nextTurnTick = 100 + TICKS_PER_MONTH;
    expect(replay).toStrictEqual({
      state: expectedState,
      turns: { ...r0.turns, 1: [...r0.turns[1]!.slice(1), { commandKey: 'rest', args: {} }] },
      revisions: { 1: 1, 2: 0, 3: 0, 4: 0 },
      monthlyTick: 0,
    });
    expect(r0).toStrictEqual(before);
    expect(Object.hasOwn(replay.state, 'ext')).toBe(false);
  });
});

it('keeps each definition paired with its unchanged spec and shared functions', () => {
  const specs = [fireAttackSpec, sabotageSpec, inciteSpec, plunderSpec];
  stratagemCommands.forEach((def, i) => {
    expect([def.key, def.name]).toStrictEqual([specs[i]!.key, specs[i]!.name]);
    expect(def.target).toBe('general');
    expect(def.category).toBe('strategy');
    expect(def.args).toBe(stratagemArgs);
    expect(def.check).toBe(checkStratagem);
    expect(def.precheck).toBe(checkStratagem);
  });
});

it('accepts general preset registration and rejects nation registration without activating product presets', () => {
  const folder = new URL('../../../../../../resources/preset/', import.meta.url);
  const files = readdirSync(folder).filter((file) => file.endsWith('.json'));
  expect(files.sort()).toStrictEqual(['beginner.json', 'hardcore.json', 'regular.json', 'speed.json']);
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
  for (const value of [toWorldState(commandInitial()), cloneWorld(state), applyEffects(state, result.effects)])
    expect(Object.hasOwn(value, 'ext')).toBe(false);
});

it('replays twelve enabled months deterministically without an ext key', () => {
  function replay() {
    const state = world();
    state.generals[1]!.userId = 'user';
    let current: ReplayState = {
      state,
      turns: Object.fromEntries([1, 2, 3, 4].map((id) => [id, emptyTurns()])),
      revisions: { 1: 0, 2: 0, 3: 0, 4: 0 },
      monthlyTick: 0,
    };
    current.turns[1]![0] = { commandKey: 'fire_attack', args };
    while (current.monthlyTick < 120000) {
      expect(Object.hasOwn(current.state, 'ext')).toBe(false);
      current = runReplayAction(current, 'stratagem-replay', testUnits, active);
    }
    expect(Object.hasOwn(current.state, 'ext')).toBe(false);
    return current;
  }
  expect(replay()).toStrictEqual(replay());
});
