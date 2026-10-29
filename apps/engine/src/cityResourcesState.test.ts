import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@opensamguk/db';
import { emptyCityResourcesState, toWorldState, type WorldState } from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';
import { assertStoredCityResources, persistCityResourcesState, readStoredCityResources } from './cityResourcesState';

let initial: WorldState;
beforeAll(async () => {
  initial = toWorldState(await monthlyFixture());
});
function fixture() {
  const world = structuredClone(initial);
  world.ruleFeatures = ['campaign-v1', 'campaign-assignment-v2', 'city-resources-v1'];
  world.cityResources = emptyCityResourcesState(world);
  return world;
}
const client = (execute = vi.fn(async () => 1)) => ({
  execute,
  tx: { $executeRaw: execute } as unknown as Prisma.TransactionClient,
});

describe('AC-INT-18B 도시 저장 경계', () => {
  it('기존 월드는 NULL을 읽고 새 필드를 덧붙이지 않는다', async () => {
    const old = structuredClone(initial);
    delete old.ruleFeatures;
    expect(readStoredCityResources(null, old, [])).toBeUndefined();
    const { tx, execute } = client();
    await persistCityResourcesState(tx, 'old', old, structuredClone(old), []);
    expect(execute).not.toHaveBeenCalled();
    expect(Object.hasOwn(old, 'cityResources')).toBe(false);
  });
  it('새 원장을 엄격히 읽고 참조를 공유하지 않는다', () => {
    const world = fixture();
    const read = readStoredCityResources(world.cityResources, world, [1100])!;
    read.cities[Object.keys(read.cities)[0]!]!.gold = 5;
    expect(world.cityResources).toEqual(emptyCityResourcesState(world));
  });
  it.each([null, undefined, {}, { version: 2, cities: {} }])(
    '기능 ON의 누락·잘못된 조각을 복구하지 않는다 (%s)',
    (value) => {
      expect(() => readStoredCityResources(value, fixture(), [1100])).toThrow();
    },
  );
  it('OFF 비NULL과 의존 누락·도시 누락·없는 병종을 거부한다', () => {
    const world = fixture();
    expect(() => readStoredCityResources(world.cityResources, initial, [1100])).toThrow('끈');
    expect(() =>
      readStoredCityResources(world.cityResources, { ...world, ruleFeatures: ['city-resources-v1'] }, [1100]),
    ).toThrow('의존');
    const missing = structuredClone(world.cityResources!);
    delete missing.cities[Object.keys(missing.cities)[0]!];
    expect(() => readStoredCityResources(missing, world, [1100])).toThrow('대응');
    const unknown = structuredClone(world.cityResources!);
    unknown.cities[Object.keys(unknown.cities)[0]!]!.garrison = [{ crewType: 1200, troops: 1, train: 1, atmos: 1 }];
    expect(() => readStoredCityResources(unknown, world, [1100])).toThrow('병종');
  });
  it('동일 값은 SQL을 실행하지 않고 바뀐 값은 이전 JSON과 worldId를 CAS한다', async () => {
    const before = fixture(),
      next = structuredClone(before);
    const { tx, execute } = client();
    await persistCityResourcesState(tx, 'own-world', before, next, [1100]);
    expect(execute).not.toHaveBeenCalled();
    next.cityResources!.cities[Object.keys(next.cities)[0]!]!.gold = 100;
    await persistCityResourcesState(tx, 'own-world', before, next, [1100]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]!.slice(1)).toEqual([
      JSON.stringify(next.cityResources),
      'own-world',
      JSON.stringify(before.cityResources),
    ]);
  });
  it.each([0, 2])('CAS가 %i행이면 호출자 턴을 실패시킨다', async (rows) => {
    const before = fixture(),
      next = structuredClone(before);
    next.cityResources!.cities[Object.keys(next.cities)[0]!]!.rice = 1;
    const { tx } = client(vi.fn(async () => rows));
    await expect(persistCityResourcesState(tx, 'own-world', before, next, [1100])).rejects.toThrow('바뀌었습니다');
  });
  it('실행 도중 원장 생성·삭제·형식 변경을 거부한다', async () => {
    const current = fixture(),
      old = structuredClone(initial);
    delete old.ruleFeatures;
    const { tx, execute } = client();
    await expect(persistCityResourcesState(tx, 'w', old, current, [1100])).rejects.toThrow('추가하거나');
    await expect(persistCityResourcesState(tx, 'w', current, old, [1100])).rejects.toThrow('추가하거나');
    const invalid = structuredClone(current);
    invalid.cityResources!.cities[Object.keys(invalid.cities)[0]!]!.gold = -1;
    await expect(persistCityResourcesState(tx, 'w', current, invalid, [1100])).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it('재생 수출의 OFF 비NULL도 거점 조회 전에 차단한다', async () => {
    const findMany = vi.fn();
    const tx = { city: { findMany } } as unknown as Prisma.TransactionClient;
    const world = {
      id: 'w',
      replayFormat: 1,
      ruleFeatures: [],
      replayOrigin: null,
      unitSet: {},
      cityResourcesState: {},
    };
    await expect(assertStoredCityResources(tx, world)).rejects.toThrow('끈');
    expect(findMany).not.toHaveBeenCalled();
    await assertStoredCityResources(tx, { ...world, cityResourcesState: null });
    expect(findMany).not.toHaveBeenCalled();
  });
});
