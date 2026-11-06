import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { cloneWorld } from '../model/clone';
import {
  NATION_LIFECYCLE_FEATURE,
  assertNationLifecycle,
  initialNationLifecycle,
  isWandering,
  readNationLifecycle,
} from './state';

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
