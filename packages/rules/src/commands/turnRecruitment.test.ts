import { expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldState } from '../model/world';
import { initialNationLifecycle } from '../nationLifecycle/state';
import { resolverForRuleFeatures } from '../ruleCommands';
import { runGeneralTurn } from './turn';

const firstMonthOf195 = 36 * TICKS_PER_MONTH;
function fixture() {
  const world = commandWorld();
  world.startYear = 192;
  world.nations[1]!.isNpc = false;
  world.commandMeta = { nextNationId: 3, offers: { 4: 1 }, lastNationRecruitmentLock: { fromYear: 195 } };
  return world;
}

function run(state: WorldState, tick: number, generalId: number, commandKey: string, args: unknown = {}) {
  return runGeneralTurn(
    state,
    { generalId, tick, unitSet: testUnits },
    { commandKey, args },
    'recruitment-lock',
    {},
    resolverForRuleFeatures(state),
  );
}

it('AC-P2-24 195년 전 멸망은 임관을 막지 않고 경계일에도 소급하지 않는다', () => {
  const { state } = run(fixture(), firstMonthOf195 - 1, 1, 'attack', { cityKey: 2 });
  expect(Object.keys(state.nations)).toEqual(['1']);
  expect(state.commandMeta?.lastNationRecruitmentLock).toEqual({ fromYear: 195 });
  const { state: next } = run(state, firstMonthOf195, 4, 'accept_invite');
  expect(next.generals[4]!.nationId).toBe(1);
  expect(next.commandMeta?.lastNationRecruitmentLock).toEqual({ fromYear: 195 });
});

it('AC-P2-24 경계일부터 멸망한 턴에 남은 국가의 직접·무작위 임관과 등용 수락을 막는다', () => {
  const before = fixture();
  const { state } = run(before, firstMonthOf195, 1, 'attack', { cityKey: 2 });
  expect(state.cities[3]!.nationId).toBeNull();
  expect(state.commandMeta?.lastNationRecruitmentLock).toEqual({ fromYear: 195, blockedNationId: 1 });
  expect(before.commandMeta?.lastNationRecruitmentLock).toEqual({ fromYear: 195 });
  for (const [key, args] of [
    ['join', { nationId: 1 }],
    ['join_random', {}],
    ['accept_invite', {}],
  ] as const) {
    const attempt = run(state, firstMonthOf195 + 1, 4, key, args);
    expect(attempt.result).toMatchObject({ code: 'PROTECTED' });
    expect(attempt.state).toEqual(state);
  }
});

it('AC-P2-24 후발 국가는 무작위 임관 후보가 된다', () => {
  const { state } = run(fixture(), firstMonthOf195, 1, 'attack', { cityKey: 2 });
  const { state: founded } = run(state, firstMonthOf195 + 1, 4, 'found', { name: '후발국', color: '#123456' });
  expect(founded.nations[3]!.name).toBe('후발국');
  const { state: joined } = run(founded, firstMonthOf195 + 2, 2, 'join_random');
  expect(joined.generals[2]!.nationId).toBe(3);
  expect(joined.commandMeta?.lastNationRecruitmentLock?.blockedNationId).toBe(1);
});

it('AC-P2-24 방랑국 자진 해산으로 한 나라가 남아도 임관을 허용한다', () => {
  const world = fixture();
  world.nations[2]!.isNpc = false;
  world.diplomacies = [];
  world.ruleFeatures = ['nation-lifecycle-v1', 'personnel'];
  world.nationLifecycle = initialNationLifecycle();
  const wandering = run(world, firstMonthOf195, 2, 'wander');
  expect(wandering.state.nationLifecycle?.nations[2]).toEqual({ sinceTick: firstMonthOf195 });
  const { state } = run(wandering.state, firstMonthOf195 + 1, 2, 'disband');
  expect(Object.keys(state.nations)).toEqual(['1']);
  expect(state.commandMeta?.lastNationRecruitmentLock).toEqual({ fromYear: 195 });
  const { state: joined } = run(state, firstMonthOf195 + 2, 4, 'join', { nationId: 1 });
  expect(joined.generals[4]!.nationId).toBe(1);
});
