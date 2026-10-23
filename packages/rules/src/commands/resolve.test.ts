import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { commandCases } from './contracts';
import { commands, runCommand } from './registry';
import { createCommandResolver, createCommandResolverWithCommands } from './resolve';
import { runGeneralTurn } from './turn';
import type { CommandDef } from './types';

const extension: CommandDef = {
  ...commands[0]!,
  key: 't_a',
  args: z.strictObject({ count: z.number().default(7) }),
  precheck: (_view, _actor, args) =>
    (args as { count: number }).count === 7 ? null : { code: 'BAD_STATE', message: '검사 실패' },
  check: (_view, _actor, args) =>
    (args as { count: number }).count === 7 ? null : { code: 'NO_GOLD', message: '실행 실패' },
  execute: () => ({ effects: [], logs: [] }),
};
const extensions = [extension, { ...extension, key: 't_b' }, { ...extension, key: 't_n', target: 'nation' as const }];

describe('null resolver의 기존 명령 호환', () => {
  const resolver = createCommandResolver(null);
  for (const [key, test] of Object.entries(commandCases)) {
    for (const rejected of [false, true])
      it(`${key} ${rejected ? '실패' : '성공'}의 결과·사전 검사·RNG가 같다`, () => {
        const state = commandWorld();
        test.prepare?.(state);
        if (rejected) test.reject(state);
        const before = structuredClone(state);
        const def = resolver.get(key)!;
        const actor = { generalId: test.actor ?? 1, target: def.target, tick: 100, unitSet: testUnits };
        const direct = rngFor('resolver-contract', key);
        const resolved = rngFor('resolver-contract', key);
        expect(resolver.run(state, actor, key, test.args, resolved)).toEqual(
          runCommand(state, actor, key, test.args, direct),
        );
        expect(resolved.next()).toEqual(direct.next());
        expect(resolver.precheck(state, actor, key, test.args)).toEqual(
          def.precheck(state, actor, def.args.parse(test.args)),
        );
        expect(state).toEqual(before);
      });
  }
  it('37개 목록과 없는 key·대상·인자 오류도 같다', () => {
    const state = commandWorld();
    expect(resolver.list('general')).toEqual(commands.filter((def) => def.target === 'general'));
    expect(resolver.list('nation')).toEqual(commands.filter((def) => def.target === 'nation'));
    for (const [key, actor, args] of [
      ['missing', { generalId: 1 }, {}],
      ['farm', { generalId: 1, target: 'nation' as const }, {}],
      ['farm', { generalId: 1 }, { unexpected: true }],
    ] as const) {
      const expected = runCommand(state, actor, key, args, rngFor('errors'));
      expect(resolver.run(state, actor, key, args, rngFor('errors'))).toEqual(expected);
      expect(resolver.precheck(state, actor, key, args)).toEqual(expected);
    }
  });
});

it('확장 목록 순서를 따르고 enabled와 반환 목록의 변경을 보관하지 않는다', () => {
  const enabled = { general: ['t_b', 't_a'], nation: ['t_n'] };
  const resolver = createCommandResolverWithCommands(enabled, extensions);
  enabled.general.length = 0;
  expect(
    resolver
      .list('general')
      .slice(-2)
      .map((def) => def.key),
  ).toEqual(['t_a', 't_b']);
  (resolver.list('general') as CommandDef[]).length = 0;
  expect(resolver.get('t_a')).toBe(extension);
  expect(resolver.list('general')).toHaveLength(29);
});

it('꺼진 확장 key는 기존 UNKNOWN_COMMAND와 구별하고 대상·인자보다 먼저 거부한다', () => {
  const resolver = createCommandResolverWithCommands(null, extensions);
  const state = commandWorld();
  const actor = { generalId: 1, target: 'nation' as const };
  expect(resolver.get('t_a')).toBeUndefined();
  expect(resolver.precheck(state, actor, 't_a', null)).toMatchObject({ code: 'COMMAND_DISABLED' });
  const rng = rngFor('disabled');
  expect(resolver.run(state, actor, 't_a', null, rng)).toMatchObject({ code: 'COMMAND_DISABLED' });
  expect(rng.next()).toBe(rngFor('disabled').next());
  expect(runCommand(state, actor, 't_a', null, rng)).toMatchObject({ code: 'UNKNOWN_COMMAND' });
});

it('켠 확장 명령은 대상·파싱·사전 검사·실행 검사를 순서대로 거친다', () => {
  const resolver = createCommandResolverWithCommands({ general: ['t_a'], nation: [] }, extensions);
  const world = commandWorld();
  const actor = { generalId: 1 };
  const run = (args: unknown) => resolver.run(world, actor, 't_a', args, rngFor('ext'));
  expect(resolver.precheck(world, { ...actor, target: 'nation' }, 't_a', {})).toMatchObject({
    code: 'BAD_ARGS',
    message: '명령 대상이 다릅니다.',
  });
  expect(run({ count: '7' })).toMatchObject({ code: 'BAD_ARGS' });
  expect(resolver.precheck(world, actor, 't_a', { count: 8 })).toMatchObject({ code: 'BAD_STATE' });
  expect(run({ count: 8 })).toMatchObject({ code: 'NO_GOLD' });
  expect(resolver.precheck(world, actor, 't_a', {})).toBeNull();
  expect(run({})).toEqual({ effects: [], logs: [] });
});

it('기본·없는·중복·대상이 다른 확장 설정과 registry 충돌을 거부한다', () => {
  for (const general of [['farm'], ['missing'], ['t_a', 't_a'], ['t_n']]) {
    expect(() => createCommandResolverWithCommands({ general, nation: [] }, extensions)).toThrow(general[0]);
  }
  expect(() => createCommandResolverWithCommands(null, [extension, extension])).toThrow('t_a');
  expect(() => createCommandResolverWithCommands(null, [{ ...extension, key: 'farm' }])).toThrow('farm');
});

it('장수·국가 예턴과 NPC 선택 및 convergence 옵션은 null resolver와 같다', () => {
  for (const npc of [false, true]) {
    const state = commandWorld();
    if (!npc) state.generals[1]!.userId = 'user';
    state.nationTurns = { 1: [{ commandKey: 'nation_rest', args: {} }] };
    for (const options of [{}, { convergence: false }]) {
      const args = [
        state,
        { generalId: 1, tick: 100, unitSet: testUnits },
        { commandKey: 'rest', args: {} },
        'turn-compat',
        options,
      ] as const;
      expect(runGeneralTurn(...args, createCommandResolver(null))).toEqual(runGeneralTurn(...args));
    }
  }
});

it('국가·장수 두 실행 지점에 주입한 resolver를 넘긴다', () => {
  const world = commandWorld();
  world.generals[1]!.userId = 'user';
  world.nationTurns = { 1: [{ commandKey: 't_n', args: {} }] };
  const resolver = createCommandResolverWithCommands({ general: ['t_a'], nation: ['t_n'] }, extensions);
  const result = runGeneralTurn(world, { generalId: 1 }, { commandKey: 't_a', args: {} }, 'ext', {}, resolver);
  expect(result.nation?.result).toEqual({ effects: [], logs: [] });
  expect(result.result).toEqual({ effects: [], logs: [] });
});
