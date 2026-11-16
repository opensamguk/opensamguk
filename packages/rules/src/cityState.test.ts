import { describe, expect, it } from 'vitest';
import { createRng, type Rng } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../test/commandFixture';
import { assignCountyParents, captureCounties, countyDetached, countyTaxDestination } from './cityAffiliation';
import { commandAttackTargets, commandMoveTargets } from './commandPaths';
import { settleDisaster, expireCityStates, disasterProbability } from './monthly/disaster';
import { runGeneralTurn } from './commands/turn';
import { runCommand } from './commands/registry';
import { applyEffects } from './commands/effects';
import { unifiedNation } from './season';
import { sabotage } from './commands/ext/stratagem/sabotage';
import { incite } from './commands/ext/stratagem/incite';
import { emptyCityResourcesState } from './cityResources/state';
import { settleIncome, runMonthly } from './monthly';
import { applyCityResourceIncome } from './cityResourceIncome';

function world() {
  const state = commandWorld();
  for (const city of Object.values(state.cities))
    Object.assign(city, { state: 0, stateTerm: 0, kind: 'CITY', level: 5, parentCityKey: null });
  return state;
}
function scripted(values: number[], picked = 0): Rng {
  return {
    next: () => {
      const value = values.shift();
      if (value === undefined) throw Error('RNG 초과 소비');
      return value;
    },
    int: (min) => min,
    pick: (items) => items[picked]!,
  };
}
describe('AC-INT-27·28 D-101 도시 상태와 D-102 부속 현', () => {
  it('치안 확률의 양 끝과 시작 3년 유예·이전 표시 해제를 지킨다', () => {
    expect(disasterProbability(0, 100, false)).toBeCloseTo(0.06);
    expect(disasterProbability(100, 100, false)).toBeCloseTo(0.01);
    expect(disasterProbability(0, 100, true)).toBeCloseTo(0.02);
    expect(disasterProbability(100, 100, true)).toBeCloseTo(0.07);
    const state = world();
    state.cities[1]!.state = 7;
    expect(settleDisaster(state, { year: 193, month: 1 }, scripted([]))).toEqual([]);
    expect(state.cities[1]!.state).toBe(0);
    const none = settleDisaster(state, { year: 194, month: 1 }, scripted([0.06, 0.06, 0.06, 0.06]));
    expect(none).toEqual([]);
  });
  it('재해 배율·부상·물 거점 선별·부상 난수와 관·전장 제외를 지킨다', () => {
    const state = world();
    state.cities[2]!.level = 1;
    state.cities[3]!.kind = 'PASS';
    state.cities[4]!.kind = 'FIELD';
    state.generals = { 1: state.generals[1]! };
    const city = state.cities[1]!,
      before = city.population;
    state.generals[1]!.injury = 79;
    const logs = settleDisaster(state, { year: 194, month: 4 }, scripted([0.9, 0, 0, 0], 0));
    expect(city.population).toBe(Math.round(before * (0.8 + (100 / 1000 / 0.8) * 0.15)));
    expect(city.state).toBe(7);
    expect(state.cities[2]!.state).toBe(7);
    expect(state.cities[3]!.state).toBe(0);
    expect(state.cities[4]!.state).toBe(0);
    expect(state.generals[1]!.injury).toBe(80);
    expect(state.generals[1]!.crew).toBe(9800);
    expect(logs.some((log) => log.kind === 'disaster' && log.generalId === 1)).toBe(true);
    const dry = world();
    dry.cities[2]!.level = 1;
    dry.generals = {};
    settleDisaster(dry, { year: 194, month: 1 }, scripted([0, 0, 1, 1]));
    expect(dry.cities[2]!.state).toBe(0);
  });
  it('호황 상한과 상태 기간을 지킨다', () => {
    const state = world();
    state.generals = {};
    state.cities[1]!.security = 1000;
    state.cities[1]!.population = 50000;
    const logs = settleDisaster(state, { year: 194, month: 4 }, scripted([0, 0, 1, 1, 1]));
    expect(logs[0]!.kind).toBe('boom');
    expect(state.cities[1]!.population).toBe(50000);
    expect(state.cities[1]!.commerce).toBe(105);
    expireCityStates(state);
    expireCityStates(state);
    expireCityStates(state);
    expect(state.cities[1]!.state).toBe(0);
  });
  it('같은 군·길 거리·키 순으로 부모를 고정하고 수비 없는 현만 함께 넘어간다', () => {
    const state = world();
    const county = state.cities[2]!;
    county.level = 2;
    state.cities[3]!.kind = 'PASS';
    state.cities[4]!.region = 2;
    assignCountyParents(Object.values(state.cities));
    expect(county.parentCityKey).toBe(1);
    const reversed = Object.values(structuredClone(state.cities)).reverse();
    assignCountyParents(reversed);
    expect(reversed.find((city) => city.cityKey === 2)!.parentCityKey).toBe(1);
    expect(countyDetached(county, state.cities)).toBe(true);
    captureCounties(state, 1);
    expect(county.nationId).toBe(2);
    state.generals[2]!.cityKey = 3;
    state.generals[3]!.cityKey = 3;
    captureCounties(state, 1);
    expect(county.nationId).toBe(1);
    expect(countyDetached(county, state.cities)).toBe(false);
    expect(countyTaxDestination(state, 2)).toBe(1);
    county.nationId = 2;
    state.cities[3]!.kind = 'CITY';
    state.cities[3]!.nationId = 2;
    expect(countyTaxDestination(state, 2)).toBe(3);
  });
  it('계략 성공은32이며 관문에는 파괴만 허용한다', () => {
    const state = world();
    state.cities[2]!.kind = 'PASS';
    const actor = { generalId: 1, tick: 100, unitSet: testUnits };
    expect(sabotage.check(state, actor, { cityKey: 2 })).toBeNull();
    expect(incite.check(state, actor, { cityKey: 2 })).toMatchObject({ code: 'BAD_TARGET' });
    const result = sabotage.execute(state, actor, { cityKey: 2 }, { ...createRng('city-state'), next: () => 0 });
    expect(applyEffects(state, result.effects).cities[2]).toMatchObject({ state: 32, stateTerm: 3 });
  });
  it('통일은 큰 도시만 센다', () => {
    const state = world();
    for (const city of Object.values(state.cities)) city.nationId = 1;
    state.cities[2]!.level = 2;
    state.cities[2]!.nationId = null;
    expect(unifiedNation(state)).toBe(1);
  });
  it('부모와 이반 현의 창고에 금·쌀을 적립하며 국고와 총량을 보존한다', () => {
    const state = world();
    state.cityResources = emptyCityResourcesState(state);
    state.cities[2]!.parentCityKey = 1;
    state.cities[2]!.level = 2;
    state.cities[2]!.nationId = 1;
    for (const month of [1, 4]) {
      const date = { year: 191, month };
      const attached = applyCityResourceIncome(state, settleIncome(state, date), date);
      const resource = month === 1 ? 'gold' : 'rice';
      expect(attached.cityResources!.cities['2']![resource]).toBe(0);
      expect(attached.cityResources!.cities['1']![resource]).toBeGreaterThan(0);
      const detached = structuredClone(state);
      detached.cities[2]!.nationId = 2;
      detached.cities[3]!.nationId = 2;
      const result = applyCityResourceIncome(detached, settleIncome(detached, date), date);
      expect(result.cityResources!.cities['2']![resource]).toBe(0);
      expect(result.cityResources!.cities['3']![resource]).toBeGreaterThan(0);
      expect(result.nations[2]![resource]).toBe(state.nations[2]![resource]);
    }
    state.cityResources.cities['2']!.garrison = [{ crewType: 1100, troops: 1, train: 0, atmos: 0 }];
    state.generals = {};
    state.cities[1]!.nationId = 2;
    captureCounties(state, 1);
    expect(state.cities[2]!.nationId).toBe(1);
  });
  it('월 정산 난수를 소비하지 않고 분리한 시드로 같은 상태·기록을 재생한다', () => {
    const state = world(),
      monthly = createRng('monthly'),
      control = createRng('monthly');
    const first = runMonthly(state, 370000, monthly, createRng('city-disaster'));
    expect(monthly.next()).toBe(control.next());
    expect(first).toEqual(
      runMonthly(JSON.parse(JSON.stringify(state)), 370000, createRng('monthly'), createRng('city-disaster')),
    );
    expect(state.cities[1]!.state).toBe(0);
  });
});
describe('AC-INT-28 D-103 목적지 이동·출병', () => {
  it('두 칸당 한 턴으로 이동하고 다음 예턴은 계속 이동한다', () => {
    const state = world();
    for (const city of Object.values(state.cities)) city.nationId = 1;
    const target = commandMoveTargets(state, 1).find((row) => row.cityKey === 4)!;
    expect(target).toEqual({ cityKey: 4, path: [1, 2, 3, 4], turns: 2, sweptCounties: [], blockedBy: null });
    const first = runGeneralTurn(
      state,
      { generalId: 1, tick: 100 },
      { commandKey: 'move', args: { cityKey: 4 } },
      'move',
    );
    expect(first.state.generals[1]).toMatchObject({ cityKey: 3, movePath: [4] });
    expect(commandMoveTargets(first.state, 1)).toEqual([
      { cityKey: 4, path: [3, 4], turns: 1, sweptCounties: [], blockedBy: null },
    ]);
    const next = runGeneralTurn(first.state, { generalId: 1, tick: 10100 }, { commandKey: 'rest', args: {} }, 'move');
    expect(next.commandKey).toBe('move');
    expect(next.state.generals[1]!.cityKey).toBe(4);
    expect(next.state.generals[1]!.movePath).toBeUndefined();
    first.state.cities[4]!.nationId = 2;
    const stopped = runGeneralTurn(
      first.state,
      { generalId: 1, tick: 10100 },
      { commandKey: 'rest', args: {} },
      'move',
    );
    expect(stopped.state.generals[1]!.cityKey).toBe(3);
    expect(stopped.state.generals[1]!.movePath).toBeUndefined();
  });
  it('큰 도시까지 수비 없는 부속 현만 지나며 막은 현 이름을 남긴다', () => {
    const state = world();
    state.cities[2]!.level = 2;
    state.cities[2]!.parentCityKey = 3;
    state.cities[3]!.nationId = 2;
    expect(commandAttackTargets(state, 1).find((row) => row.cityKey === 3)).toMatchObject({
      path: [1, 2, 3],
      blockedBy: 2,
    });
    expect(
      runCommand(state, { generalId: 1, tick: 100, unitSet: testUnits }, 'attack', { cityKey: 3 }, createRng('attack')),
    ).toMatchObject({ code: 'BLOCKED_BY_COUNTY', message: expect.stringContaining('도시2') });
    state.generals[2]!.cityKey = 4;
    state.generals[3]!.cityKey = 4;
    expect(commandAttackTargets(state, 1).find((row) => row.cityKey === 3)).toMatchObject({
      sweptCounties: [2],
      blockedBy: null,
    });
    const result = runCommand(
      state,
      { generalId: 1, tick: 100, unitSet: testUnits },
      'attack',
      { cityKey: 3 },
      createRng('capture-parent'),
    );
    if ('code' in result) throw Error(result.message);
    const captured = applyEffects(state, result.effects);
    expect(captured.cities[3]).toMatchObject({ nationId: 1, state: 43, stateTerm: 3 });
    expect(captured.cities[2]!.nationId).toBe(1);
  });
});
