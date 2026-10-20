import { describe, expect, it } from 'vitest';
import map from '../resources/map/che.json';
import scenario from '../resources/scenario/1030.json';
import unitSet from '../resources/unitset/basic.json';
import statRules from '../resources/scenario/default.json';
import { createRng } from '../packages/shared/src/rng';
import { applyEffects, buildInitialWorld, commands, runCommand, toWorldState } from '../packages/rules/src/index';

function fixture() {
  const state = toWorldState(buildInitialWorld({ map, scenario, unitSet, statRules, seed: 'command-fixture' }));
  const general = Object.values(state.generals).find((general) => general.name === '조조')!;
  general.cityKey = state.nations[general.nationId!]!.capitalCityKey;
  general.injury = 10;
  return { state, general, actor: { generalId: general.id }, city: state.cities[general.cityKey]! };
}
describe('AC-M1-14 T1-05 명령 9종', () => {
  for (const command of commands) {
    it(`${command.key}: 성공과 효과 적용`, () => {
      const { state, general, actor } = fixture();
      const before = structuredClone(state);
      expect(command.precheck(state, actor, {})).toBeNull();
      const result = runCommand(state, actor, command.key, {}, createRng('success'));
      expect('effects' in result).toBe(true);
      if (!('effects' in result)) throw new Error(result.message);
      const next = applyEffects(state, result.effects);
      expect(state).toEqual(before);
      expect(result.logs).toHaveLength(1);
      if (command.key === 'rest') expect(next.generals[general.id]!.injury).toBe(9);
      else expect(next.generals[general.id]!.gold).toBe(general.gold - (['settle', 'goodwill'].includes(command.key) ? 200 : 100));
    });
    it(`${command.key}: 대표 실패는 효과를 만들지 않는다`, () => {
      const { state, general, actor } = fixture();
      general.gold = 0;
      const invalidActor = command.key === 'rest' ? { generalId: -1 } : actor;
      expect(runCommand(state, invalidActor, command.key, {}, createRng('failure')))
        .toMatchObject({ code: command.key === 'rest' ? 'NO_ACTOR' : 'NO_GOLD' });
    });
  }
  it('고정 시드 농지 개간 결과를 고정한다', () => {
    const { state, actor, general, city } = fixture();
    const result = runCommand(state, actor, 'farm', {}, createRng('farm-golden'));
    if (!('effects' in result)) throw new Error(result.message);
    const next = applyEffects(state, result.effects);
    expect({ agriculture: next.cities[city.cityKey]!.agriculture, gold: next.generals[general.id]!.gold,
      experience: next.generals[general.id]!.experience, dedication: next.generals[general.id]!.dedication })
      .toMatchInlineSnapshot(`
        {
          "agriculture": 1014,
          "dedication": 14,
          "experience": 10,
          "gold": 900,
        }
      `);
  });
  it.each([
    { key: 'settle', population: 100506, trust: 50, experience: 35, dedication: 51 },
    { key: 'goodwill', population: 100000, trust: 54.47190701123327, experience: 31, dedication: 45 },
  ])('고정 시드 $key 결과에 도시값의 단위와 2배 비용을 반영한다', (expected) => {
    const { state, actor, general, city } = fixture();
    const result = runCommand(state, actor, expected.key, {}, createRng(`${expected.key}-golden`));
    if (!('effects' in result)) throw new Error(result.message);
    const next = applyEffects(state, result.effects);
    expect({ population: next.cities[city.cityKey]!.population, trust: next.cities[city.cityKey]!.trust,
      gold: next.generals[general.id]!.gold, experience: next.generals[general.id]!.experience,
      dedication: next.generals[general.id]!.dedication }).toEqual({
      population: expected.population, trust: expected.trust, gold: 800,
      experience: expected.experience, dedication: expected.dedication,
    });
  });
  it('정착·선정은 금 199를 거부하고 200부터 허용하며 실패 시 RNG를 소비하지 않는다', () => {
    for (const key of ['settle', 'goodwill']) {
      const { state, general, actor } = fixture();
      const command = commands.find((command) => command.key === key)!;
      general.gold = 199;
      expect(command.precheck(state, actor, {})).toMatchObject({ code: 'NO_GOLD' });
      expect(command.check(state, actor, {})).toMatchObject({ code: 'NO_GOLD' });
      const rng = { ...createRng('cost'), next: () => { throw new Error('실패 시 난수 소비'); } };
      expect(runCommand(state, actor, key, {}, rng)).toMatchObject({ code: 'NO_GOLD' });
      general.gold = 200;
      expect(command.precheck(state, actor, {})).toBeNull();
      const result = runCommand(state, actor, key, {}, createRng('cost'));
      if (!('effects' in result)) throw new Error(result.message);
      expect(applyEffects(state, result.effects).generals[general.id]!.gold).toBe(0);
    }
  });
  it('정착·선정의 경험·공헌은 도시값 단위 배율의 영향을 받지 않는다', () => {
    for (const key of ['settle', 'goodwill']) {
      const { state, general, actor, city } = fixture();
      general.leadership = 80; city.trust = 50; state.diplomacies = [];
      const values = [0.55, 0.5];
      const rng = { ...createRng('reward'), next: () => values.shift()! };
      const result = runCommand(state, actor, key, {}, rng);
      if (!('effects' in result)) throw new Error(result.message);
      const next = applyEffects(state, result.effects);
      expect(next.generals[general.id]).toMatchObject({ experience: 29, dedication: 41, gold: 800 });
      if (key === 'settle') expect(next.cities[city.cityKey]!.population).toBe(city.population + 408);
      else expect(next.cities[city.cityKey]!.trust).toBeCloseTo(54.08, 12);
      expect(values).toEqual([]);
    }
  });
  it('정착·선정의 배율 적용 뒤에도 인구·민심 최대치를 넘지 않는다', () => {
    for (const key of ['settle', 'goodwill']) {
      const { state, actor, city } = fixture();
      city.population = city.populationMax - 1; city.trust = 99.9;
      const result = runCommand(state, actor, key, {}, createRng('cap'));
      if (!('effects' in result)) throw new Error(result.message);
      const next = applyEffects(state, result.effects);
      if (key === 'settle') expect(next.cities[city.cityKey]!.population).toBe(city.populationMax);
      else expect(next.cities[city.cityKey]!.trust).toBe(100);
    }
  });
  it('소유·보급·최대치와 잘못된 인자를 거부한다', () => {
    const { state, actor, city } = fixture();
    city.nationId = null;
    expect(runCommand(state, actor, 'farm', {}, createRng('x'))).toMatchObject({ code: 'NOT_OWN_CITY' });
    city.nationId = 1; city.supplied = false;
    expect(runCommand(state, actor, 'farm', {}, createRng('x'))).toMatchObject({ code: 'NO_SUPPLY' });
    city.supplied = true; city.agriculture = city.agricultureMax;
    expect(runCommand(state, actor, 'farm', {}, createRng('x'))).toMatchObject({ code: 'AT_MAX' });
    expect(runCommand(state, actor, 'farm', { extra: true }, createRng('x'))).toMatchObject({ code: 'BAD_ARGS' });
    expect(runCommand(state, actor, 'missing', {}, createRng('x'))).toMatchObject({ code: 'UNKNOWN_COMMAND' });
  });
  it('전선은 점수를 절반으로 만들고 치명 RNG는 정해진 순서로 소비한다', () => {
    const { state, actor, general, city } = fixture();
    general.intel = 100; city.trust = 100;
    const neighbor = state.cities[city.connections[0]!]!; neighbor.nationId = 2;
    state.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 1000 }];
    const values = [0.5, 0.05, 0.5];
    const rng = { ...createRng('x'), next: () => values.shift()! };
    const result = runCommand(state, actor, 'farm', {}, rng);
    if (!('effects' in result)) throw new Error(result.message);
    expect(result.effects[0]).toMatchObject({ value: 130 });
    expect(values).toEqual([]);
  });
  it('효과는 0 하한·최대치를 지키고 잘못된 대상을 거부한다', () => {
    const { state, actor, city } = fixture();
    const next = applyEffects(state, [
      { kind: 'city', id: city.cityKey, field: 'agriculture', op: 'set', value: 1e9 },
      { kind: 'general', id: actor.generalId, field: 'gold', op: 'set', value: -100 },
      { kind: 'city', id: city.cityKey, field: 'trust', op: 'set', value: 12.5 },
    ]);
    expect(next.cities[city.cityKey]!.agriculture).toBe(city.agricultureMax);
    expect(next.generals[actor.generalId]!.gold).toBe(0);
    expect(next.cities[city.cityKey]!.trust).toBe(12.5);
    expect(() => applyEffects(state, [{ kind: 'general', id: -1, field: 'gold', op: 'set', value: 1 }])).toThrow();
  });
});
