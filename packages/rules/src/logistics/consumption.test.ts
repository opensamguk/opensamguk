import { createRng } from '@opensamguk/shared';
import { describe, expect, it, vi } from 'vitest';
import { commandInitial, commandWorld, testUnits } from '../../test/commandFixture';
import { createCampaignCommandResolver } from '../campaign/commands';
import { emptyCampaignState } from '../campaign/state';
import { createCityResourceCommandResolver } from '../cityResources/commands';
import { cityNpcPreparation } from '../cityResources/npc';
import { CITY_RESOURCE_MAX, emptyCityResourcesState } from '../cityResources/state';
import { applyEffects } from '../commands/effects';
import { createCommandResolver } from '../commands/resolve';
import { cloneWorld } from '../model/clone';
import { deepFreeze } from '../personnel/testFixture';
import { affordableByGoods, consumeCityGoods, logisticsCommandMovements, recruitGoods } from './consumption';
import { logisticsFeature } from './feature';
import { assertLogisticsConserved } from './ledger';
import { initialLogisticsState, type LogisticsConfig } from './state';

const config: LogisticsConfig = {
  version: 1,
  specialties: [],
  capacity: { base: 1000, perLevel: 1000, maxLevel: 2 },
  upgrade: { gold: 1, wood: 1 },
  transport: { maxHops: 8, hopsPerMonth: 2, lossBpPerHop: 100, maxPerOrder: 100, maxActivePerNation: 2 },
  recruitPer100: {
    '1': { iron: 2, wood: 0, horses: 0 },
    '2': { iron: 0, wood: 3, horses: 0 },
    '3': { iron: 1, wood: 0, horses: 1 },
  },
  build: { wall: { iron: 0, wood: 4, horses: 0 }, defence: { iron: 2, wood: 3, horses: 0 } },
  trade: { iron: { buy: 3, sell: 1 }, wood: { buy: 3, sell: 1 }, horses: { buy: 3, sell: 1 } },
};
const resolver = createCityResourceCommandResolver(createCampaignCommandResolver(createCommandResolver(null)));
const actor = { generalId: 1, tick: 100, unitSet: testUnits };
function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats', 'city-resources-v1', 'logistics-v1'];
  for (const general of Object.values(world.generals)) Object.assign(general, { politics: 60, charm: 55, crew: 0 });
  world.campaign = emptyCampaignState(world, 'consumption', 'source-fixture');
  world.cityResources = emptyCityResourcesState(world);
  world.cityResources.cities['1']!.gold = 100_000;
  world.cityResources.cities['1']!.rice = 100_000;
  world.logistics = initialLogisticsState(config, world);
  Object.assign(world.logistics.cities['1']!, { iron: 20, wood: 20, horses: 20 });
  return world;
}
function spend(world: ReturnType<typeof fixture>, cost: { iron: number; wood: number; horses: number }) {
  const result = consumeCityGoods(deepFreeze(world), 1, cost);
  if (!result.ok) throw new Error(result.message);
  const next = cloneWorld(world);
  next.logistics = result.logistics;
  return next;
}

describe('AC-P2-30 모집·건설의 실제 원자재 소비', () => {
  it.each([99, 100, 101])('%i명은 병과별 100명 단위 올림 비용을 쓴다', (amount) => {
    const world = fixture(),
      before = cloneWorld(world);
    const result = resolver.run(deepFreeze(world), actor, 'recruit', { amount, crewType: 1300 }, createRng('recruit'));
    if ('code' in result) throw new Error(result.message);
    const after = applyEffects(world, result.effects),
      units = Math.ceil(amount / 100);
    expect(after.cityResources!.cities['1']!.garrison).toMatchObject([{ crewType: 1300, troops: amount }]);
    expect(after.cityResources!.cities['1']!.gold).toBeLessThan(before.cityResources!.cities['1']!.gold);
    expect(after.cities[1]!.population).toBe(before.cities[1]!.population - amount);
    expect(after.logistics!.cities['1']).toMatchObject({ iron: 20 - units, wood: 20, horses: 20 - units });
    expect(logisticsCommandMovements(world, after)).toEqual([
      { holder: 'city', id: 1, good: 'iron', delta: -units, reason: 'CONSUME' },
      { holder: 'city', id: 1, good: 'horses', delta: -units, reason: 'CONSUME' },
    ]);
    expect(world).toEqual(before);
  });
  it('징병도 모집 비용을 내고 궁병은 목재를 쓴다', () => {
    const world = fixture();
    const result = resolver.run(
      deepFreeze(world),
      actor,
      'conscript',
      { amount: 101, crewType: 1200 },
      createRng('conscript'),
    );
    if ('code' in result) throw new Error(result.message);
    const after = applyEffects(world, result.effects);
    expect(after.logistics!.cities['1']).toMatchObject({ iron: 20, wood: 14, horses: 20 });
    expect(after.cities[1]!.trust).toBeLessThan(world.cities[1]!.trust);
  });
  it.each(['recruit', 'conscript', 'wall', 'defence'])('%s 부족은 RNG·재고·인구·금·병력을 바꾸지 않는다', (key) => {
    const world = fixture();
    Object.assign(world.logistics!.cities['1']!, { iron: 0, wood: 0, horses: 0 });
    const before = cloneWorld(world),
      rng = createRng('failure'),
      next = vi.spyOn(rng, 'next');
    expect(
      resolver.run(
        deepFreeze(world),
        actor,
        key,
        key === 'recruit' || key === 'conscript' ? { amount: 100, crewType: 1100 } : {},
        rng,
      ),
    ).toMatchObject({ code: 'NO_GOODS' });
    expect(next).not.toHaveBeenCalled();
    expect(world).toEqual(before);
  });
  it.each(['wall', 'defence'] as const)('%s는 기존 효과와 RNG를 유지하고 성공당 한 번 소비한다', (key) => {
    const world = fixture(),
      legacy = cloneWorld(world);
    legacy.ruleFeatures = legacy.ruleFeatures!.filter((flag) => flag !== 'logistics-v1');
    delete legacy.logistics;
    const rng = createRng('build'),
      oldRng = createRng('build');
    const next = vi.spyOn(rng, 'next'),
      oldNext = vi.spyOn(oldRng, 'next');
    const result = resolver.run(deepFreeze(world), actor, key, {}, rng);
    const oldResult = resolver.run(deepFreeze(legacy), actor, key, {}, oldRng);
    if ('code' in result || 'code' in oldResult) throw new Error('건설 실패');
    const after = applyEffects(world, result.effects),
      oldAfter = applyEffects(legacy, oldResult.effects);
    expect(after.cities).toEqual(oldAfter.cities);
    expect(after.generals).toEqual(oldAfter.generals);
    expect(after.cityResources).toEqual(oldAfter.cityResources);
    expect(next.mock.calls.length).toBe(oldNext.mock.calls.length);
    expect(logisticsCommandMovements(world, after)).toEqual(
      Object.entries(config.build[key])
        .filter(([, value]) => value > 0)
        .map(([good, value]) => ({ holder: 'city', id: 1, good, delta: -value, reason: 'CONSUME' })),
    );
    expect(after.logistics!.revision).toBe(1);
  });
  it('최대 성벽은 비용을 쓰지 않는다', () => {
    const world = fixture(),
      before = structuredClone(world.logistics!);
    world.cities[1]!.wall = world.cities[1]!.wallMax;
    expect(resolver.run(deepFreeze(world), actor, 'wall', {}, createRng('max'))).toMatchObject({ code: 'AT_MAX' });
    expect(world.logistics).toEqual(before);
  });
  it('정확한 재고를 쓰고 0 비용은 revision과 원장도 남기지 않는다', () => {
    const world = fixture(),
      next = spend(world, { iron: 20, wood: 20, horses: 20 });
    expect(next.logistics!.cities['1']).toEqual({ iron: 0, wood: 0, horses: 0, level: 0 });
    const free = spend(world, { iron: 0, wood: 0, horses: 0 });
    expect(free.logistics).toEqual(world.logistics);
    expect(logisticsCommandMovements(world, free)).toEqual([]);
  });
  it('큰 유효 비용은 넘치지 않고 부족으로 판정하며 revision 한도도 검사한다', () => {
    const world = fixture(),
      expensive = structuredClone(config);
    expensive.recruitPer100['1']!.iron = CITY_RESOURCE_MAX;
    const cost = recruitGoods(expensive, 1, 1_000_000);
    expect(cost.iron).toBe(CITY_RESOURCE_MAX * 10_000);
    expect(consumeCityGoods(world, 1, cost)).toMatchObject({ ok: false, code: 'NO_GOODS' });
    world.logistics!.revision = CITY_RESOURCE_MAX;
    expect(consumeCityGoods(world, 1, { iron: 1, wood: 0, horses: 0 })).toMatchObject({ ok: false, code: 'BAD_STATE' });
  });
  it('NPC는 원자재로 가능한 모집 수를 고르고 재고 0이면 모집하지 않는다', () => {
    const world = fixture();
    world.logistics!.cities['1']!.iron = 8;
    expect(
      cityNpcPreparation(deepFreeze(cloneWorld(world)), 1, { unitSet: testUnits }).find(
        (choice) => choice.key === 'recruit',
      )?.args,
    ).toEqual({ amount: 400, crewType: 1100 });
    world.logistics!.cities['1']!.iron = 0;
    expect(cityNpcPreparation(world, 1, { unitSet: testUnits }).some((choice) => choice.key === 'recruit')).toBe(false);
    expect(affordableByGoods({ iron: 1, wood: 5, horses: 2 }, { iron: 0, wood: 0, horses: 0 }, 199)).toBe(199);
  });
  it('두 소비를 한 차례에 합쳐도 원장과 보유량을 보존한다', () => {
    const world = fixture(),
      once = spend(world, { iron: 1, wood: 0, horses: 0 });
    const twice = spend(once, { iron: 1, wood: 0, horses: 0 });
    expect(twice.logistics!.revision).toBe(2);
    expect(logisticsCommandMovements(world, twice)).toEqual([
      { holder: 'city', id: 1, good: 'iron', delta: -2, reason: 'CONSUME' },
    ]);
  });
  it.each(['stock', 'level', 'tick', 'config', 'revision'] as const)(
    '일반 명령의 허용 범위 밖 %s 변경을 거절한다',
    (field) => {
      const world = fixture(),
        next = cloneWorld(world);
      if (field === 'stock') next.logistics!.cities['1']!.iron++;
      if (field === 'level') next.logistics!.cities['1']!.level++;
      if (field === 'tick') next.logistics!.monthlyTick = 10_000;
      if (field === 'config') next.logistics!.config.transport.maxHops++;
      if (field === 'revision') next.logistics!.revision++;
      expect(() => logisticsCommandMovements(world, next)).toThrow();
    },
  );
  it('수송대 감소를 소비로 위장할 수 없다', () => {
    const world = fixture(),
      before = world.logistics!,
      after = structuredClone(before);
    before.nextConvoyId = 2;
    before.convoys = [
      {
        id: 1,
        nationId: 1,
        fromCityKey: 1,
        toCityKey: 2,
        path: [1, 2],
        goods: { iron: 1, wood: 0, horses: 0 },
        departTick: 1,
        arriveTick: 10_000,
      },
    ];
    expect(() =>
      assertLogisticsConserved(before, after, [
        { holder: 'convoy', id: 1, good: 'iron', delta: -1, reason: 'CONSUME' },
      ]),
    ).toThrow('도시');
  });
  it('원생성의 모든 군사 병과 비용을 요구하고 무료도 명시해야 한다', () => {
    const initial = commandInitial();
    expect(() => logisticsFeature.checkOrigin!({ initial, data: config })).not.toThrow();
    const missing = structuredClone(config);
    delete missing.recruitPer100['3'];
    expect(() => logisticsFeature.checkOrigin!({ initial, data: missing })).toThrow('모든 군사 병과');
    expect(() => recruitGoods(missing, 3, 1)).toThrow('없는 병과');
    const free = structuredClone(config);
    free.recruitPer100['3'] = { iron: 0, wood: 0, horses: 0 };
    expect(() => logisticsFeature.checkOrigin!({ initial, data: free })).not.toThrow();
    free.recruitPer100['99'] = { iron: 0, wood: 0, horses: 0 };
    expect(() => logisticsFeature.checkOrigin!({ initial, data: free })).toThrow('모든 군사 병과');
  });
});
