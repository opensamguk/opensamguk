import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { deepFreeze } from '../personnel/testFixture';
import { CITY_RESOURCE_MAX, cityResourcesStateSchema, emptyCityResourcesState, readCityResourcesState } from './state';

describe('AC-INT-18A 도시 자원 정본', () => {
  it('모든 거점에서 0으로 시작하고 개인·국고 자원을 복사하지 않는다', () => {
    const world = commandWorld();
    world.cities[4]!.kind = 'PASS';
    const before = structuredClone(world);
    const state = emptyCityResourcesState(deepFreeze(world));
    expect(state).toEqual({
      version: 1,
      cities: Object.fromEntries([1, 2, 3, 4].map((key) => [key, { gold: 0, rice: 0, garrison: [] }])),
    });
    expect(world).toEqual(before);
    state.cities['1']!.gold = 1;
    expect(state.cities['2']!.gold).toBe(0);
  });

  it('정상 수량 경계와 여러 병종 합계를 보존하고 새 복사본만 정렬한다', () => {
    const world = commandWorld();
    const state = emptyCityResourcesState(world);
    state.cities['1'] = {
      gold: CITY_RESOURCE_MAX,
      rice: CITY_RESOURCE_MAX,
      garrison: [
        { crewType: 1200, troops: 7, train: 100, atmos: 0 },
        { crewType: 1100, troops: CITY_RESOURCE_MAX - 7, train: 0, atmos: 100 },
      ],
    };
    const before = structuredClone(state);
    const result = readCityResourcesState(deepFreeze(state), world, [1100, 1200]);
    expect(result.cities['1']!.garrison.map((row) => row.crewType)).toEqual([1100, 1200]);
    expect(result.cities['1']!.garrison.map((row) => row.troops)).toEqual([CITY_RESOURCE_MAX - 7, 7]);
    expect(result.cities['1']!.gold).toBe(CITY_RESOURCE_MAX);
    expect(state).toEqual(before);
    expect(result).not.toBe(state);
    expect(result.cities['1']).not.toBe(state.cities['1']);
  });

  it.each(['missing', 'foreign', 'alias', 'world-mismatch'] as const)('%s 도시 키 대응을 거부한다', (kind) => {
    const world = commandWorld();
    const state = emptyCityResourcesState(world);
    if (kind === 'missing') delete state.cities['4'];
    if (kind === 'foreign') state.cities['5'] = { gold: 0, rice: 0, garrison: [] };
    if (kind === 'alias') {
      state.cities['01'] = state.cities['1']!;
      delete state.cities['1'];
    }
    if (kind === 'world-mismatch') world.cities[1]!.cityKey = 5;
    expect(() => readCityResourcesState(state, world)).toThrow();
  });

  it.each([
    { version: 2 },
    { extra: 0 },
    { cities: { '1': { gold: 0, rice: 0, garrison: [], extra: 1 } } },
    { cities: { '1': { gold: '0', rice: 0, garrison: [] } } },
    { cities: { '1': { rice: 0, garrison: [] } } },
  ])('판·필드·타입·누락을 추정값으로 고치지 않는다: %j', (override) => {
    expect(() => cityResourcesStateSchema.parse({ version: 1, cities: {}, ...override })).toThrow();
  });

  it.each([-1, 0.5, CITY_RESOURCE_MAX + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    '금·쌀·병력의 잘못된 수량 %s를 거부한다',
    (quantity) => {
      for (const field of ['gold', 'rice', 'troops'] as const) {
        const state = emptyCityResourcesState(commandWorld());
        const city = state.cities['1']!;
        city.garrison = [{ crewType: 1100, troops: 1, train: 50, atmos: 50 }];
        if (field === 'troops') city.garrison[0]!.troops = quantity;
        else city[field] = quantity;
        expect(() => readCityResourcesState(state, commandWorld())).toThrow();
      }
    },
  );

  it.each([-1, 0.5, 101])('훈련·사기 %s를 거부한다', (score) => {
    for (const field of ['train', 'atmos'] as const) {
      const state = emptyCityResourcesState(commandWorld());
      state.cities['1']!.garrison = [{ crewType: 1100, troops: 1, train: 50, atmos: 50, [field]: score }];
      expect(() => readCityResourcesState(state, commandWorld())).toThrow();
    }
  });

  it('각 병종이 범위 안이어도 도시 전체 병력 합계 초과를 거부한다', () => {
    const state = emptyCityResourcesState(commandWorld());
    state.cities['1']!.garrison = [
      { crewType: 1100, troops: CITY_RESOURCE_MAX, train: 0, atmos: 0 },
      { crewType: 1200, troops: 1, train: 0, atmos: 0 },
    ];
    expect(() => readCityResourcesState(state, commandWorld())).toThrow('도시 전체 병력');
  });

  it('중복 병종을 합쳐서 읽지 않는다', () => {
    const state = emptyCityResourcesState(commandWorld());
    state.cities['1']!.garrison = Array.from({ length: 2 }, () => ({ crewType: 1100, troops: 1, train: 0, atmos: 0 }));
    expect(() => readCityResourcesState(state, commandWorld())).toThrow('중복');
  });

  it('군사 병종 목록이 있으면 없는 병종과 성벽 병종을 거부한다', () => {
    const world = commandWorld();
    for (const crewType of [1000, 9999]) {
      const state = emptyCityResourcesState(world);
      state.cities['1']!.garrison = [{ crewType, troops: 1, train: 0, atmos: 0 }];
      expect(() => readCityResourcesState(state, world, [1100, 1200])).toThrow('군사 병종');
    }
    expect(() => readCityResourcesState(emptyCityResourcesState(world), world, [1100, 1100])).toThrow('중복');
    expect(() => readCityResourcesState(emptyCityResourcesState(world), world, [0])).toThrow();
  });
});
