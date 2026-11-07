import { expect, it } from 'vitest';
import { commandInitial, commandWorld } from '../../test/commandFixture';
import { cloneWorld } from '../model/clone';
import { initialReplayState } from '../replay';
import { checkReplayOrigin } from '../ruleRegistry';
import { settleNationLifecycleMonthly } from './monthly';
import {
  NATION_LIFECYCLE_FEATURE,
  assertInitialNationLifecycle,
  assertNationLifecycle,
  initialNationLifecycle,
  isWandering,
  readNationLifecycle,
} from './state';

it('시작 방랑의 원장은 null 수도에서만 도출하고 이전 영토 월드의 빈 원장을 보존한다', () => {
  const initial = commandInitial();
  expect(initialNationLifecycle(initial.nations)).toEqual(initialNationLifecycle());
  initial.nations[0]!.capitalCityKey = null;
  for (const city of initial.cities) if (city.nationId === 1) city.nationId = null;
  initial.ruleFeatures = ['nation-lifecycle-v1', 'personnel'];
  const before = structuredClone(initial);
  expect(() => assertInitialNationLifecycle(initial, false)).toThrow('형식 3');
  expect(() => assertInitialNationLifecycle(initial, true)).not.toThrow();
  const replay = initialReplayState(initial);
  expect(replay.state.nationLifecycle).toEqual({ version: 1, nations: { 1: { sinceTick: 0 } } });
  expect(() => assertNationLifecycle(replay.state)).not.toThrow();
  expect(initial).toEqual(before);
});

it('생성 원본은 수도와 영토를 함께 검사하고 런타임 방랑의 이전 수도는 유지한다', () => {
  const initial = commandInitial();
  initial.nations[0]!.capitalCityKey = null;
  expect(() => assertInitialNationLifecycle(initial, true)).toThrow('수도와 소유 도시');
  initial.nations[0]!.capitalCityKey = 1;
  for (const city of initial.cities) if (city.nationId === 1) city.nationId = null;
  expect(() => assertInitialNationLifecycle(initial, true)).toThrow('수도와 소유 도시');
  const world = commandWorld();
  world.ruleFeatures = ['nation-lifecycle-v1', 'personnel'];
  world.nationLifecycle = { version: 1, nations: { 1: { sinceTick: 123 } } };
  for (const city of Object.values(world.cities)) if (city.nationId === 1) city.nationId = null;
  expect(() => assertNationLifecycle(world)).not.toThrow();
  world.nations[1]!.capitalCityKey = null;
  expect(() => assertNationLifecycle(world)).not.toThrow();
  world.nationLifecycle = initialNationLifecycle();
  expect(() => assertNationLifecycle(world)).toThrow('방랑 원장이 없습니다');
  delete world.ruleFeatures;
  delete world.nationLifecycle;
  expect(() => assertNationLifecycle(world)).toThrow('방랑 원장이 없습니다');
});

it('시작 시각 0의 방랑은 23개월에 남고 정확 24개월 정산에서 한 번 해산된다', () => {
  const initial = commandInitial();
  initial.nations[0]!.capitalCityKey = null;
  for (const city of initial.cities) if (city.nationId === 1) city.nationId = null;
  initial.ruleFeatures = ['nation-lifecycle-v1', 'personnel'];
  const world = initialReplayState(initial).state;
  expect(settleNationLifecycleMonthly(world, 230_000).state.nations[1]).toBeDefined();
  const ended = settleNationLifecycleMonthly(world, 240_000);
  expect(ended.state.nations[1]).toBeUndefined();
  expect(ended.state.nations[2]).toBeDefined();
  expect(ended.effects.history).toHaveLength(1);
  expect(settleNationLifecycleMonthly(ended.state, 250_000).effects.history).toEqual([]);
  expect(world.nations[1]).toBeDefined();
});

it('시작 방랑 재생 기원은 형식 3과 명시한 인사·국가 변천 기능을 요구한다', () => {
  const initial = commandInitial();
  initial.nations[0]!.capitalCityKey = null;
  for (const city of initial.cities) if (city.nationId === 1) city.nationId = null;
  const origin = { version: 3, initial, initialStateHash: '0'.repeat(64), resourceHash: '0'.repeat(64) };
  expect(() => checkReplayOrigin(origin)).toThrow('형식 3');
  initial.ruleFeatures = ['personnel'];
  expect(() => checkReplayOrigin(origin)).toThrow('형식 3');
  initial.ruleFeatures = ['nation-lifecycle-v1', 'personnel'];
  expect(() => checkReplayOrigin(origin)).not.toThrow();
  expect(() => checkReplayOrigin({ ...origin, version: 1 })).toThrow('형식 3');
});

it('꺼진 월드에는 원장을 만들지 않고 누락·null만 허용한다', () => {
  const world = commandWorld();
  expect(readNationLifecycle(undefined, world)).toBeUndefined();
  expect(readNationLifecycle(null, world)).toBeUndefined();
  expect(() => readNationLifecycle(initialNationLifecycle(), world)).toThrow('기능을 끈');
  expect(Object.hasOwn(cloneWorld(world), 'nationLifecycle')).toBe(false);
  expect(isWandering(world, 1)).toBe(false);
});

it('켜진 월드는 엄격한 원장과 실제 존재하는 무도시 국가만 허용한다', () => {
  const world = commandWorld();
  world.ruleFeatures = [NATION_LIFECYCLE_FEATURE];
  expect(() => assertNationLifecycle(world)).toThrow();
  world.nationLifecycle = initialNationLifecycle();
  expect(() => assertNationLifecycle(world)).not.toThrow();
  world.nationLifecycle.nations['1'] = { sinceTick: 123 };
  expect(() => assertNationLifecycle(world)).toThrow('도시를 소유');
  for (const city of Object.values(world.cities)) if (city.nationId === 1) city.nationId = null;
  expect(() => assertNationLifecycle(world)).not.toThrow();
  expect(isWandering(world, 1)).toBe(true);
  expect(isWandering(world, null)).toBe(false);
  world.nationLifecycle.nations['999'] = { sinceTick: 0 };
  expect(() => assertNationLifecycle(world)).toThrow('국가가 없습니다');
});

it('변형 키·시각·추가 필드를 거부하고 복제한 원장이 원본을 바꾸지 않는다', () => {
  const world = commandWorld();
  world.ruleFeatures = [NATION_LIFECYCLE_FEATURE];
  for (const nations of [
    { '01': { sinceTick: 0 } },
    { '1': { sinceTick: -1 } },
    { '1': { sinceTick: 0.5 } },
    { '1': { sinceTick: 2_147_483_648 } },
    { '1': { sinceTick: 0, unknown: true } },
  ])
    expect(() => readNationLifecycle({ version: 1, nations }, world)).toThrow();
  world.nationLifecycle = { version: 1, nations: { '1': { sinceTick: 123 } } };
  const copied = cloneWorld(world);
  copied.nationLifecycle!.nations['1']!.sinceTick = 456;
  expect(world.nationLifecycle.nations['1']!.sinceTick).toBe(123);
});
