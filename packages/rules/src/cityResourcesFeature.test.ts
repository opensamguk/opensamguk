import { expect, it } from 'vitest';
import { commandWorld } from '../test/commandFixture';
import { cityResourcesFeature } from './cityResourcesFeature';
import { emptyCityResourcesState } from './cityResources/state';
import { cloneWorld, cloneWorldWithRegistry } from './model/clone';
import type { ReplayState } from './replay';
import { ruleRegistry } from './ruleRegistry';
import type { WorldInit } from './world/bootstrap';

it('INT-18A 기존 월드 복제는 도시 자원 필드나 초기 자원을 추가하지 않는다', () => {
  const old = commandWorld();
  const before = JSON.stringify(old);
  const cloned = cloneWorld(old);
  expect(JSON.stringify(cloned)).toBe(before);
  expect(Object.hasOwn(cloned, 'cityResources')).toBe(false);
  expect(ruleRegistry.features.some((feature) => feature.key === 'city-resources-v1')).toBe(false);
});

it('INT-18A 새 원장은 도시별 0에서 시작하고 기존 국고·개인 잔액을 복사하지 않는다', () => {
  const world = commandWorld();
  const before = structuredClone(world);
  const replay: ReplayState = { state: world, turns: {}, revisions: {}, monthlyTick: 0 };
  const result = cityResourcesFeature.initReplayState!(replay, { initial: {} as WorldInit, data: undefined });
  expect(result.state.cityResources).toEqual(emptyCityResourcesState(world));
  expect(Object.values(result.state.cityResources!.cities).every((city) => city.gold === 0 && city.rice === 0)).toBe(
    true,
  );
  expect(result.state.nations).toEqual(before.nations);
  expect(result.state.generals).toEqual(before.generals);
  expect(world).toEqual(before);
});

it.each([
  cloneWorld,
  (world: ReturnType<typeof commandWorld>) => cloneWorldWithRegistry(world, { slices: [], bindings: [] }),
])('INT-18A 도시 원장의 금·쌀·병종 배열은 복제 뒤 원본과 참조를 공유하지 않는다', (clone) => {
  const world = commandWorld();
  world.cityResources = emptyCityResourcesState(world);
  const cityKey = Object.keys(world.cityResources.cities)[0]!;
  world.cityResources.cities[cityKey]!.garrison.push({ crewType: 1, troops: 100, train: 30, atmos: 40 });
  const before = structuredClone(world);
  const result = clone(world);
  result.cityResources!.cities[cityKey]!.gold = 12;
  result.cityResources!.cities[cityKey]!.rice = 13;
  result.cityResources!.cities[cityKey]!.garrison[0]!.troops = 1;
  result.cityResources!.cities[cityKey]!.garrison.push({ crewType: 2, troops: 10, train: 0, atmos: 0 });
  expect(world).toEqual(before);
});

it('INT-18A 초기 자원 주입과 중복 초기화는 실패한다', () => {
  const initial = {} as WorldInit;
  expect(() => cityResourcesFeature.checkOrigin!({ initial, data: {} })).toThrow('빈 원장');
  expect(() =>
    cityResourcesFeature.checkOrigin!({ initial: { ...initial, cityResources: {} } as WorldInit, data: undefined }),
  ).toThrow('빈 원장');
  const world = commandWorld();
  world.cityResources = emptyCityResourcesState(world);
  expect(() =>
    cityResourcesFeature.initReplayState!(
      { state: world, turns: {}, revisions: {}, monthlyTick: 0 },
      { initial, data: undefined },
    ),
  ).toThrow('중복');
});
