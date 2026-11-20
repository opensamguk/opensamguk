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
  world.cityResources = emptyCityResourcesState(world);
  return world;
}
const client = (execute = vi.fn(async () => 1)) => ({
  execute,
  tx: { $executeRaw: execute } as unknown as Prisma.TransactionClient,
});

describe('AC-INT-18B 도시 저장 경계', () => {
  it('AC-INT-28 필수 도시 원장 NULL은 읽기와 저장 모두 거부한다', async () => {
    const old = structuredClone(initial);
    expect(() => readStoredCityResources(null, old, [])).toThrow();
    const { tx, execute } = client();
    await expect(persistCityResourcesState(tx, 'old', old, structuredClone(old), [])).rejects.toThrow();
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
  it('원장을 기능 선택 없이 읽고 도시 누락·없는 병종을 거부한다', () => {
    const world = fixture();
    expect(readStoredCityResources(world.cityResources, initial, [1100])).toEqual(world.cityResources);
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
    const { tx, execute } = client();
    await expect(persistCityResourcesState(tx, 'w', old, current, [1100])).rejects.toThrow();
    await expect(persistCityResourcesState(tx, 'w', current, old, [1100])).rejects.toThrow();
    const invalid = structuredClone(current);
    invalid.cityResources!.cities[Object.keys(invalid.cities)[0]!]!.gold = -1;
    await expect(persistCityResourcesState(tx, 'w', current, invalid, [1100])).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it('구판 재생 수출은 원장 값과 무관하게 거점 조회 전에 차단한다', async () => {
    const findMany = vi.fn();
    const tx = { city: { findMany } } as unknown as Prisma.TransactionClient;
    const world = {
      id: 'w',
      replayFormat: 1,

      replayOrigin: null,
      unitSet: {},
      cityResourcesState: {},
    };
    await expect(assertStoredCityResources(tx, world)).rejects.toThrow('새 판 재생 형식');
    expect(findMany).not.toHaveBeenCalled();
    await expect(assertStoredCityResources(tx, { ...world, cityResourcesState: null })).rejects.toThrow(
      '새 판 재생 형식',
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
