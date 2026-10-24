import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { testUnits } from '../../test/commandFixture';
import { chooseGeneralTurn, chooseNationTurn } from '../npc';
import { completePersonnelStep } from '../personnel/step';
import { deepFreeze, personnelWorld } from '../personnel/testFixture';
import { PersonnelInvariantError } from '../personnel/types';
import { applyEffects } from './effects';
import { commandRegistry, runCommand } from './registry';
import { createCommandResolver } from './resolve';
import { runGeneralTurn } from './turn';
import type { Actor, CommandResult } from './types';

const seed = 'office-turn';
const actor = { generalId: 4, tick: 100, unitSet: testUnits };
const rest = { commandKey: 'rest', args: {} };
const reward = { commandKey: 'nation_reward', args: { generalId: 3, resource: 'gold', amount: 5 } };
function world(level = 5) {
  const state = personnelWorld();
  state.generals[4]!.officerLevel = level;
  if (level === 12) state.generals[1]!.officerLevel = 1;
  state.officeTurns = {
    1: {
      [level]: [
        structuredClone(reward),
        ...Array.from({ length: 11 }, () => ({ commandKey: 'nation_rest', args: {} })),
      ],
    },
  };
  return state;
}
function succeeded(result: CommandResult | { code: string; message: string }): CommandResult {
  if ('code' in result) throw new Error(result.message);
  return result;
}
function observed() {
  const base = createCommandResolver(null);
  const calls: { key: string; actor: Actor; officerLevel: number; sample: number }[] = [];
  const resolver = {
    ...base,
    run(...args: Parameters<typeof base.run>) {
      expect(this).toBe(resolver);
      // 이 관측 시험의 포상·휴식은 난수를 쓰지 않는다. 실제 명령 실행은 그대로 전달한다.
      calls.push({
        key: args[2],
        actor: { ...args[1] },
        officerLevel: args[0].generals[args[1].generalId]!.officerLevel,
        sample: args[4].next(),
      });
      return base.run(...args);
    },
  };
  return { resolver, calls };
}

describe('인사 직책 칸의 턴 연결', () => {
  it.each([5, 6, 7, 8, 9, 10, 11, 12])('직책 값 %i의 국가 칸을 먼저 실행하고 12칸을 당긴다', (level) => {
    const state = world(level);
    const offices = { 1: { [level]: { revision: 7, tenure: 2 } }, 2: { 12: { revision: 3, tenure: 4 } } };
    const before = structuredClone({ state, offices });
    const turn = runGeneralTurn(deepFreeze(state), actor, rest, seed, {}, undefined, { offices: deepFreeze(offices) });
    expect(turn.nation!.commandKey).toBe('nation_reward');
    expect('code' in turn.nation!.result).toBe(false);
    expect(turn.state.nations[1]!.gold).toBe(state.nations[1]!.gold - 5);
    expect(turn.state.generals[3]!.gold).toBe(state.generals[3]!.gold + 5);
    expect(turn.state.generals[4]!.officerLevel).toBe(level);
    expect(turn.state.officeTurns![1]![level]).toEqual(
      Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })),
    );
    expect(turn.personnel!.offices).toEqual({
      1: { [level]: { revision: 8, tenure: 2 } },
      2: { 12: { revision: 3, tenure: 4 } },
    });
    expect(turn.personnel!.closedOffers).toEqual([]);
    expect(turn.personnel!.logs).toEqual([]);
    expect({ state, offices }).toEqual(before);
    expect(turn.state.generals[4]!.nextTurnTick).toBe(state.generals[4]!.nextTurnTick);
    expect(Object.hasOwn(turn.state, 'nationTurns')).toBe(false);
  });

  it('칸과 카운터가 없어도 사람 직책자의 국가 휴식을 한 번 소비한다', () => {
    const state = personnelWorld();
    const turn = runGeneralTurn(deepFreeze(state), actor, rest, seed, {}, undefined, { offices: deepFreeze({}) });
    expect(turn.nation!.commandKey).toBe('nation_rest');
    expect(turn.personnel!.offices).toEqual({ 1: { 5: { revision: 1, tenure: 0 } } });
    expect(Object.hasOwn(turn.state, 'officeTurns')).toBe(false);
    expect(Object.hasOwn(turn.state, 'nationTurns')).toBe(false);
  });

  it('직책자가 아니면 국가 칸과 카운터를 소비하지 않는다', () => {
    const state = world();
    const offices = { 1: { 5: { revision: 7, tenure: 2 } } };
    const turn = runGeneralTurn(deepFreeze(state), { ...actor, generalId: 3 }, rest, seed, {}, undefined, {
      offices: deepFreeze(offices),
    });
    expect(turn.nation).toBeUndefined();
    expect(turn.personnel!.offices).toEqual(offices);
    expect(turn.personnel!.offices).not.toBe(offices);
    expect(turn.state.officeTurns).toEqual(state.officeTurns);
  });

  it('국가 명령이 실패해도 직책 칸과 revision을 소비한다', () => {
    const state = world();
    state.nations[1]!.gold = 0;
    const turn = runGeneralTurn(deepFreeze(state), actor, rest, seed, {}, undefined, {
      offices: { 1: { 5: { revision: 7, tenure: 2 } } },
    });
    expect(turn.nation!.result).toMatchObject({ code: 'NO_GOLD' });
    expect(turn.personnel!.offices[1]![5]).toEqual({ revision: 8, tenure: 2 });
    expect(turn.state.officeTurns![1]![5]![0]).toEqual({ commandKey: 'nation_rest', args: {} });
    expect(turn.state.nations[1]!.gold).toBe(0);
    expect(turn.state.generals[3]!.gold).toBe(state.generals[3]!.gold);
  });

  it('NPC 군주의 잘못된 국가 휴식 인자를 자동 선택으로 덮지 않는다', () => {
    const state = personnelWorld();
    state.officeTurns = { 1: { 12: Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })) } };
    state.officeTurns[1]![12]![0] = { commandKey: 'nation_rest', args: { invalid: true } };
    const turn = runGeneralTurn(
      deepFreeze(state),
      { ...actor, generalId: 1 },
      { commandKey: 'rest', args: { invalid: true } },
      seed,
      {},
      undefined,
      { offices: {} },
    );
    expect(turn.nation!.commandKey).toBe('nation_rest');
    expect(turn.nation!.result).toMatchObject({ code: 'BAD_ARGS' });
    expect(turn.result).toMatchObject({ code: 'BAD_ARGS' });
    expect(turn.personnel!.offices[1]![12]).toEqual({ revision: 1, tenure: 0 });
  });

  it.each([
    [5, 'nation_pact'],
    [11, 'nation_declare'],
  ] as const)('직책 값 %i의 권한 밖 명령 %s를 불변식으로 거부한다', (level, commandKey) => {
    const state = world(level);
    state.officeTurns![1]![level]![0] = { commandKey, args: { nationId: 2 } };
    const saved = structuredClone(state);
    expect(() => runGeneralTurn(deepFreeze(state), actor, rest, seed, {}, undefined, { offices: {} })).toThrow(
      '직책 칸 명령과 인자가 올바르지 않습니다.',
    );
    expect(state).toEqual(saved);
  });

  it('참모의 외교 명령은 직책 관문을 통과하며 OFF 참모는 군주 관문에 남는다', () => {
    const state = world(11);
    state.diplomacies = [];
    state.officeTurns![1]![11]![0] = { commandKey: 'nation_pact', args: { nationId: 2 } };
    const turn = runGeneralTurn(deepFreeze(state), actor, rest, seed, {}, undefined, { offices: {} });
    expect('code' in turn.nation!.result).toBe(false);
    expect(turn.state.diplomacies[0]!.state).toBe('NON_AGGRESSION');
    expect(
      runCommand(state, { ...actor, target: 'nation' }, 'nation_reward', reward.args, rngFor('off-permission')),
    ).toEqual({ code: 'NOT_RULER', message: '군주만 실행할 수 있습니다.' });
  });

  it('직책 표의 권한은 precheck와 execute의 재검사에서도 같은 장수로 통과한다', () => {
    const state = deepFreeze(world(11));
    const definition = commandRegistry.get('nation_reward')!;
    const officeActor: Actor = { ...actor, target: 'nation', authority: 'office' };
    expect(definition.precheck(state, officeActor, reward.args)).toBeNull();
    const result = definition.execute(state, officeActor, reward.args, rngFor('office-check'));
    expect(applyEffects(state, result.effects).generals[3]!.gold).toBe(state.generals[3]!.gold + 5);
    expect(state.generals[4]!.officerLevel).toBe(11);
    expect(definition.precheck(state, { ...actor, target: 'nation' }, reward.args)).toMatchObject({
      code: 'NOT_RULER',
    });
  });

  it('resolver 수신자와 실제 직책을 보존하고 기존 난수 이름을 쓴다', () => {
    const state = world(11);
    const { resolver, calls } = observed();
    const turn = runGeneralTurn(deepFreeze(state), actor, rest, seed, {}, resolver, { offices: {} });
    expect(calls.map((call) => call.key)).toEqual(['nation_reward', 'rest']);
    expect(calls.map((call) => call.officerLevel)).toEqual([11, 11]);
    expect(calls[0]!.actor).toEqual({ ...actor, target: 'nation', authority: 'office' });
    expect(calls[1]!.actor).toEqual({ ...actor, target: 'general' });
    expect(calls.map((call) => call.sample)).toEqual([
      rngFor(seed, 'nation-turn', 100, 1).next(),
      rngFor(seed, 'turn', 100, 4).next(),
    ]);
    expect('code' in turn.nation!.result).toBe(false);
  });

  it('NPC 자신을 발령한 뒤 개인 명령은 옮긴 도시에서 다시 판정한다', () => {
    const state = world();
    state.generals[4]!.userId = null;
    state.officeTurns![1]![5]![0] = { commandKey: 'nation_assign', args: { generalId: 4, cityKey: 4 } };
    const command = { commandKey: 'trade_rice', args: { amount: 1, buy: true } };
    expect('code' in runCommand(state, actor, command.commandKey, command.args, rngFor('before-move'))).toBe(false);
    const turn = runGeneralTurn(deepFreeze(state), actor, command, seed, {}, undefined, { offices: {} });
    expect(turn.state.generals[4]!.cityKey).toBe(4);
    expect(turn.result).toMatchObject({ code: 'NO_SUPPLY' });
    expect(turn.personnel!.logs.map((log) => log.commandKey)).toEqual(['nation_assign']);
    expect(turn.state.assignmentOffers).toBeUndefined();
  });

  it('사람 발령 제안 뒤 개인 하야를 raw로 싣고 caller가 W와 취소를 한 번 만든다', () => {
    const state = world();
    state.officeTurns![1]![5]![0] = { commandKey: 'nation_assign', args: { generalId: 3, cityKey: 4 } };
    const offices = { 1: { 5: { revision: 7, tenure: 2 } } };
    const turn = runGeneralTurn(deepFreeze(state), actor, { commandKey: 'resign', args: {} }, seed, {}, undefined, {
      offices: deepFreeze(offices),
    });
    expect(turn.state.generals[3]!.cityKey).toBe(1);
    expect(turn.state.generals[4]).toMatchObject({ nationId: null, officerLevel: 0 });
    expect(turn.state.assignmentOffers![3]!.id).toBe('100-4-3');
    expect(turn.personnel!.offices[1]![5]).toEqual({ revision: 8, tenure: 2 });
    expect(turn.personnel!.closedOffers).toEqual([]);
    const packet = completePersonnelStep(state, offices, { state: turn.state, ...turn.personnel! }, 100);
    expect(packet.assignment.beforeFinish.assignmentOffers![3]!.id).toBe('100-4-3');
    expect(packet.assignment.final).toEqual({});
    expect(packet.assignment.closedOffers).toEqual([
      { id: '100-4-3', status: 'CANCELLED', resolvedBy: null, resolvedTick: 100, cancelReason: 'ISSUER_LOST_OFFICE' },
    ]);
    expect(packet.offices[1]![5]).toEqual({ revision: 9, tenure: 3 });
    expect(packet.logs.map((log) => log.commandKey)).toEqual(['nation_assign', 'offer.cancel']);
  });

  it('방침 early return에도 raw 카운터를 싣고 caller의 마무리는 한 번만 한다', () => {
    const state = world();
    state.officeTurns![1]![5]![0] = { commandKey: 'nation_rest', args: {} };
    const offices = { 1: { 5: { revision: 7, tenure: 2 } } };
    const turn = runGeneralTurn(
      deepFreeze(state),
      actor,
      { ...rest, explicit: false },
      seed,
      { policy: 'none' },
      undefined,
      { offices: deepFreeze(offices) },
    );
    expect(turn.commandKey).toBe('rest');
    expect(turn.personnel!.offices[1]![5]).toEqual({ revision: 8, tenure: 2 });
    const packet = completePersonnelStep(state, offices, { state: turn.state, ...turn.personnel! }, 100);
    expect(packet.offices[1]![5]).toEqual({ revision: 8, tenure: 2 });
    expect(packet.logs).toEqual([]);
  });

  it.each(['office-npc-a', 'office-npc-b', 'office-npc-c'])(
    'NPC 군주 선택과 개인 실행은 기존 난수 이름을 따른다 (%s)',
    (npcSeed) => {
      const state = personnelWorld();
      state.cities[3]!.nationId = 1;
      state.officeTurns = { 1: { 12: Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })) } };
      const npcActor = { ...actor, generalId: 1 };
      const context = { tick: 100, unitSet: testUnits };
      const expectedNation = chooseNationTurn(
        state,
        state.generals[1]!,
        rngFor(npcSeed, 'npc-nation', 100, 1),
        context,
      ).chosen!;
      expect(expectedNation.key).toBe('nation_capital');
      const turn = runGeneralTurn(deepFreeze(state), npcActor, rest, npcSeed, {}, undefined, { offices: {} });
      expect(turn.nation!.commandKey).toBe(expectedNation.key);
      const nationResult = succeeded(turn.nation!.result);
      const afterNation = applyEffects(state, nationResult.effects);
      expect(afterNation.nations[1]!.capitalCityKey).toBe(expectedNation.args.cityKey);
      const selected = chooseGeneralTurn(
        afterNation,
        afterNation.generals[1]!,
        rngFor(npcSeed, 'npc', 100, 1),
        context,
      ).chosen!;
      expect(turn.commandKey).toBe(selected.key);
      expect(turn.result).toEqual(
        runCommand(
          afterNation,
          { ...npcActor, target: 'general' },
          selected.key,
          selected.args,
          rngFor(npcSeed, 'turn', 100, 1),
        ),
      );
      expect(turn.personnel!.offices[1]![12]).toEqual({ revision: 1, tenure: 0 });
    },
  );

  it.each([undefined, -1, 0.5, NaN])('인사 경로는 잘못된 tick 값(%s)을 기본값으로 채우지 않는다', (tick) => {
    expect(() =>
      runGeneralTurn(deepFreeze(world()), { ...actor, tick: tick as number }, rest, seed, {}, undefined, {
        offices: {},
      }),
    ).toThrow(PersonnelInvariantError);
  });

  it.each([{}, undefined])('인사 경로는 남은 국가 30칸 키를 거부한다 (%j)', (nationTurns) => {
    const state = world();
    Object.assign(state, { nationTurns });
    expect(() => runGeneralTurn(deepFreeze(state), actor, rest, seed, {}, undefined, { offices: {} })).toThrow(
      '인사 기능을 켠 월드에 국가 예턴이 있습니다.',
    );
  });
});

describe('인사 인자 없는 기존 턴', () => {
  it('기존 options·resolver 자리와 반환 네 키·actor 키를 보존한다', () => {
    const state = personnelWorld();
    state.generals[1]!.userId = 'ruler';
    state.nationTurns = { 1: [reward, ...Array.from({ length: 29 }, () => ({ commandKey: 'nation_rest', args: {} }))] };
    const { resolver, calls } = observed();
    const legacyActor = { ...actor, generalId: 1 };
    const turn = runGeneralTurn(deepFreeze(state), legacyActor, rest, seed, {}, resolver);
    expect(Object.keys(turn)).toEqual(['state', 'result', 'nation', 'commandKey']);
    expect(Object.hasOwn(turn, 'personnel')).toBe(false);
    expect(calls.map((call) => call.key)).toEqual(['nation_reward', 'rest']);
    expect(calls.every((call) => !Object.hasOwn(call.actor, 'authority'))).toBe(true);
    expect(turn.state.nationTurns![1]).toHaveLength(30);
    expect(turn.state.nationTurns![1]![0]).toEqual({ commandKey: 'nation_rest', args: {} });
    expect(Object.hasOwn(turn.state, 'officeTurns')).toBe(false);
    expect(calls.map((call) => call.sample)).toEqual([
      rngFor(seed, 'nation-turn', 100, 1).next(),
      rngFor(seed, 'turn', 100, 1).next(),
    ]);
  });

  it('기존 방침 early return은 인사 키를 만들지 않는다', () => {
    const state = personnelWorld();
    const turn = runGeneralTurn(deepFreeze(state), actor, { ...rest, explicit: false }, seed, { policy: 'none' });
    expect(Object.keys(turn)).toEqual(['state', 'result', 'nation', 'commandKey']);
    expect(Object.hasOwn(turn, 'personnel')).toBe(false);
    expect(turn.commandKey).toBe('rest');
  });

  it('인사 인자가 없는 국가 발령은 사람 대상의 기존 즉시 이동을 보존한다', () => {
    const state = personnelWorld();
    state.generals[1]!.userId = 'ruler';
    state.nationTurns = { 1: [{ commandKey: 'nation_assign', args: { generalId: 3, cityKey: 4 } }] };
    const turn = runGeneralTurn(deepFreeze(state), { ...actor, generalId: 1 }, rest, seed);
    expect(turn.state.generals[3]!.cityKey).toBe(4);
    expect(Object.hasOwn(turn.state, 'assignmentOffers')).toBe(false);
    expect(Object.hasOwn(turn, 'personnel')).toBe(false);
  });
});
