import { describe, expect, it } from 'vitest';
import type { Rng } from '@opensamguk/shared';
import { commandInitial, commandWorld, testUnits } from '../../test/commandFixture';
import { TICKS_PER_MONTH } from '../clock/constants';
import { applyEffects } from '../commands/effects';
import { createCommandResolver } from '../commands/resolve';
import { initialReplayState, runReplayAction } from '../replay';
import { resolverForRuleFeatures } from '../ruleCommands';
import { unifiedNation } from '../season';
import { treatyClosures } from '../diplomacy/treaty';
import { settleNationLifecycleMonthly } from './monthly';
import { assertNationLifecycle, initialNationLifecycle, isWandering } from './state';

const flags = ['nation-lifecycle-v1', 'personnel'];
const noRng: Rng = {
  next() {
    throw new Error('국가 변천은 난수를 쓰지 않습니다.');
  },
  int() {
    throw new Error('국가 변천은 난수를 쓰지 않습니다.');
  },
  pick() {
    throw new Error('국가 변천은 난수를 쓰지 않습니다.');
  },
};
function makeWorld() {
  const world = commandWorld();
  world.ruleFeatures = [...flags];
  world.nationLifecycle = initialNationLifecycle();
  world.diplomacies = [];
  Object.assign(world.generals[1]!, { userId: 'ruler', experience: 101 });
  Object.assign(world.generals[3]!, { nationId: 1, officerLevel: 11, cityKey: 4, userId: 'successor' });
  world.nations[1]!.isNpc = false;
  world.cities[1]!.connections.push(3);
  world.cities[3]!.connections.push(1);
  world.cities[3]!.level = 5;
  return world;
}
function wandering() {
  const world = makeWorld();
  for (const city of Object.values(world.cities)) if (city.nationId === 1) city.nationId = null;
  world.nationLifecycle!.nations['1'] = { sinceTick: 0 };
  return world;
}
function run(key: string, args: unknown, state = makeWorld(), tick = 0) {
  return resolverForRuleFeatures(state)!.run(state, { generalId: 1, tick, unitSet: testUnits }, key, args, noRng);
}
function execute(key: string, args: unknown, state = makeWorld(), tick = 0) {
  const before = structuredClone(state);
  const result = run(key, args, state, tick);
  expect(state).toEqual(before);
  if ('code' in result) throw new Error(result.message);
  return { state: applyEffects(state, result.effects), result };
}

describe('AC-P2-09 선양', () => {
  it.each([null, 'successor'])('NPC와 사람에게 넘기되 경험70%%·위치·재산·개인 연결을 보존한다 (%s)', (userId) => {
    const world = makeWorld();
    world.generals[3]!.userId = userId;
    const before = structuredClone(world);
    const { state, result } = execute('abdicate', { generalId: 3 }, world);
    expect(state.generals[1]).toEqual({ ...before.generals[1], officerLevel: 1, experience: 71 });
    expect(state.generals[3]).toEqual({ ...before.generals[3], officerLevel: 12 });
    expect(state.nations[1]).toEqual({ ...before.nations[1], isNpc: userId === null });
    expect(result.history).toHaveLength(1);
    expect(result.reports).toEqual([{ generalId: 3, text: result.logs[0]!.text }]);
  });

  it.each([
    ['본인', 1, 'BAD_TARGET'],
    ['타국', 2, 'BAD_TARGET'],
    ['재야', 4, 'BAD_TARGET'],
    ['없음', 999, 'BAD_TARGET'],
  ])('%s 대상은 거부한다', (_name, generalId, code) => {
    expect(run('abdicate', { generalId })).toMatchObject({ code });
  });

  it('미등장·내보낸 장수와 군주 아닌 행위자·위조 인자를 거부한다', () => {
    const world = makeWorld();
    world.generals[3]!.activeFromYear = 192;
    expect(run('abdicate', { generalId: 3 }, world, 119_999)).toMatchObject({ code: 'BAD_TARGET' });
    expect(run('abdicate', { generalId: 3 }, world, 120_000)).not.toHaveProperty('code');
    world.generals[3]!.removedAt = 0;
    expect(run('abdicate', { generalId: 3 }, world, 120_000)).toMatchObject({ code: 'BAD_TARGET' });
    world.generals[1]!.officerLevel = 11;
    expect(run('abdicate', { generalId: 3 }, world)).toMatchObject({ code: 'NOT_RULER' });
    expect(run('abdicate', { generalId: 3, forged: true })).toMatchObject({ code: 'BAD_ARGS' });
  });

  it('실제 재생 턴 후 두 직책12칸을 초기화하고 후계자의 개인30칸·revision은 보존한다', () => {
    const initial = commandInitial();
    initial.ruleFeatures = [...flags];
    Object.assign(initial.generals[0]!, { userId: 'ruler', experience: 101 });
    Object.assign(initial.generals[2]!, { nationId: 1, officerLevel: 11, userId: 'successor' });
    initial.nations[0]!.isNpc = false;
    const replay = initialReplayState(initial);
    replay.state.officeTurns = {
      1: Object.fromEntries(
        [11, 12].map((level) => [level, Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} }))]),
      ),
    };
    replay.offices = { 1: { 11: { revision: 7, tenure: 2 }, 12: { revision: 4, tenure: 1 } } };
    replay.residenceAnchors = { 1: 0, 3: 0 };
    replay.turns[1]![0] = { commandKey: 'abdicate', args: { generalId: 3 } };
    replay.turns[3]![0] = { commandKey: 'farm', args: {} };
    replay.state.officeTurns![1]![12]![1] = {
      commandKey: 'nation_reward',
      args: { generalId: 3, resource: 'gold', amount: 1 },
    };
    const before = structuredClone(replay);
    const after = runReplayAction(replay, initial.seed, testUnits);
    expect(after.state.generals[1]).toMatchObject({ officerLevel: 1, experience: 71 });
    expect(after.state.generals[3]).toMatchObject({ officerLevel: 12 });
    for (const level of [11, 12]) {
      expect(after.state.officeTurns![1]![level]).toEqual(
        Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })),
      );
      expect(after.offices![1]![level]!.tenure).toBe(before.offices![1]![level]!.tenure + 1);
    }
    expect(after.turns[3]).toEqual(before.turns[3]);
    expect(after.revisions[3]).toBe(before.revisions[3]);
    expect(replay).toEqual(before);
  });
});

describe('AC-P2-08 방랑과 재정착', () => {
  it('자동 해산한 같은 월에 장기 ACTIVE·미만료 PROPOSED 조약도 닫는다', () => {
    const world = wandering();
    world.ruleFeatures!.push('treaty');
    world.nationLifecycle!.nations['1'] = { sinceTick: 100 };
    world.treaties = [
      {
        id: 1,
        fromNationId: 1,
        toNationId: 2,
        clauses: [{ kind: 'note', text: '장기 기록' }],
        status: 'ACTIVE',
        proposedTick: 0,
        respondByTick: 60000,
        startTick: 1,
        endTick: null,
      },
      {
        id: 2,
        fromNationId: 1,
        toNationId: 2,
        clauses: [{ kind: 'note', text: '답변 대기' }],
        status: 'PROPOSED',
        proposedTick: 240000,
        respondByTick: 300000,
        startTick: null,
        endTick: null,
      },
    ];
    const before = settleNationLifecycleMonthly(world, 240000).state;
    expect(before.treaties).toHaveLength(2);
    const final = settleNationLifecycleMonthly(before, 250000).state;
    expect(final.nations[1]).toBeUndefined();
    expect(final.treaties ?? []).toEqual([]);
    expect(treatyClosures(before, final)).toEqual([
      { id: 1, status: 'ENDED' },
      { id: 2, status: 'EXPIRED' },
    ]);
    expect(world.treaties).toHaveLength(2);
  });
  it('도시를 포기하되 국명·색·기술·국고·장수는 유지한다', () => {
    const world = makeWorld();
    world.nations[1]!.tech = 1200;
    const before = structuredClone(world);
    const { state } = execute('wander', {}, world, 123);
    expect(state.nations).toEqual(before.nations);
    expect(state.generals).toEqual(before.generals);
    expect(Object.values(state.cities).filter((city) => city.nationId === 1)).toEqual([]);
    expect(state.nationLifecycle!.nations['1']).toEqual({ sinceTick: 123 });
    expect(() => assertNationLifecycle(state)).not.toThrow();
    expect(run('wander', {}, state)).toMatchObject({ code: 'BAD_STATE' });
  });

  it('보호 기간과 자기 국가 전쟁·선포를 검사한다', () => {
    const world = makeWorld();
    world.presetRules = {
      protection: { peaceMonths: 3, foundUntilMonths: 1, maxGeneralsPerNation: null },
      npc: { aggression: 0 },
      boost: { smallWorld: null, lateJoin: null },
    };
    expect(run('wander', {}, world, 29_999)).toMatchObject({ code: 'PROTECTED' });
    expect(run('wander', {}, world, 30_000)).not.toHaveProperty('code');
    for (const state of ['WAR', 'DECLARED'] as const) {
      world.diplomacies = [{ nationA: 1, nationB: 2, state, untilTick: 90_000 }];
      expect(run('wander', {}, world, 30_000)).toMatchObject({ code: 'BAD_STATE' });
    }
  });

  it('군주의 이동에 사람·NPC 소속 장수가 동행하고 타국·재야는 보존한다', () => {
    const world = wandering();
    const { state, result } = execute('move', { cityKey: 3 }, world);
    expect(state.generals[1]!.cityKey).toBe(3);
    expect(state.generals[3]!.cityKey).toBe(3);
    expect(state.generals[2]).toEqual(world.generals[2]);
    expect(state.generals[4]).toEqual(world.generals[4]);
    expect(result.reports).toEqual([{ generalId: 3, text: '방랑 동행: 도시3' }]);
    world.generals[1]!.officerLevel = 1;
    expect(execute('move', { cityKey: 3 }, world).state.generals[3]!.cityKey).toBe(4);
  });

  it.each([5, 6])('소속2명이 군주의 빈 규모%s 도시에 시기 제한 없이 재정착한다', (level) => {
    const world = execute('move', { cityKey: 3 }, wandering()).state;
    world.cities[3]!.level = level;
    const { state } = execute('resettle', {}, world, 100 * TICKS_PER_MONTH);
    expect(state.cities[3]!.nationId).toBe(1);
    expect(state.nations[1]).toEqual({ ...world.nations[1], capitalCityKey: 3 });
    expect(isWandering(state, 1)).toBe(false);
    expect(() => assertNationLifecycle(state)).not.toThrow();
  });

  it('정상 국가·부족한 인원·타국 도시·대규모·관문은 재정착할 수 없다', () => {
    expect(run('resettle', {})).toMatchObject({ code: 'BAD_STATE' });
    const world = execute('move', { cityKey: 3 }, wandering()).state;
    world.generals[3]!.nationId = null;
    expect(run('resettle', {}, world)).toMatchObject({ code: 'BAD_STATE' });
    world.generals[3]!.nationId = 1;
    world.cities[3]!.nationId = 2;
    expect(run('resettle', {}, world)).toMatchObject({ code: 'BAD_TARGET' });
    world.cities[3]!.nationId = null;
    world.cities[3]!.level = 7;
    expect(run('resettle', {}, world)).toMatchObject({ code: 'BAD_TARGET' });
    world.cities[3]!.level = 5;
    world.cities[3]!.kind = 'PASS';
    expect(run('resettle', {}, world)).toMatchObject({ code: 'BAD_TARGET' });
  });
});

describe('수동·24개월 자동 해산과 통일', () => {
  it('방랑 군주도 첫 달에는 거부하고 다음 달부터 전원 자원 상한·병력 해산을 적용한다', () => {
    const world = wandering();
    world.generals[3]!.rice = 7;
    expect(run('disband', {})).toMatchObject({ code: 'BAD_STATE' });
    expect(run('disband', {}, world, 9999)).toMatchObject({ code: 'PROTECTED' });
    const { state } = execute('disband', {}, world, TICKS_PER_MONTH);
    expect(state.nations[1]).toBeUndefined();
    for (const id of [1, 3])
      expect(state.generals[id]).toMatchObject({ nationId: null, officerLevel: 0, crew: 0, gold: 1000 });
    expect(state.generals[1]!.rice).toBe(1000);
    expect(state.generals[3]!.rice).toBe(7);
    expect(state.generals[2]).toEqual(world.generals[2]);
    expect(state.nationLifecycle!.nations).toEqual({});
  });

  it('월드 시작이 아닌 방랑 시작의24개월 이후 월간 경계에 해산하며 다시 적용하지 않는다', () => {
    const world = wandering();
    world.nationLifecycle!.nations['1']!.sinceTick = 123;
    const before = structuredClone(world);
    const early = settleNationLifecycleMonthly(world, 240_000);
    expect(early.state.nations[1]).toBeDefined();
    expect(early.effects.history).toEqual([]);
    const expired = settleNationLifecycleMonthly(world, 250_000);
    expect(expired.state.nations[1]).toBeUndefined();
    expect(expired.effects.history).toEqual([{ nationId: 1, text: '국가1 해산' }]);
    expect(expired.effects.reports.map((report) => report.generalId)).toEqual([1, 3]);
    expect(settleNationLifecycleMonthly(expired.state, 260_000).effects).toEqual({ history: [], reports: [] });
    expect(world).toEqual(before);
  });

  it('새 기능에서만 방랑 국가를 통일 후보에서 빼고 기존 모든 도시 조건은 유지한다', () => {
    const world = makeWorld();
    for (const city of Object.values(world.cities)) city.nationId = 1;
    world.nationLifecycle!.nations['2'] = { sinceTick: 0 };
    expect(unifiedNation(world)).toBe(1);
    world.cities[3]!.nationId = null;
    expect(unifiedNation(world)).toBeNull();
    world.cities[3]!.nationId = 1;
    delete world.ruleFeatures;
    expect(unifiedNation(world)).toBeNull();
  });

  it('새 명령은 별도 선택이며 기존 내정 settle 명령은 그대로 남는다', () => {
    const legacy = createCommandResolver(null);
    expect(legacy.get('abdicate')).toBeUndefined();
    expect(legacy.get('resettle')).toBeUndefined();
    expect(legacy.get('settle')).toMatchObject({ category: 'domestic' });
    expect(resolverForRuleFeatures(makeWorld())!.get('resettle')).toBeDefined();
  });
});
