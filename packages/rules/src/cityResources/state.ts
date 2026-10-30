import { z } from 'zod';
import type { WorldView } from '../model/world';

export const CITY_RESOURCE_MAX = 2_147_483_647;
const quantity = z.number().int().min(0).max(CITY_RESOURCE_MAX);
const identifier = quantity.min(1);

export const cityGarrisonSchema = z.strictObject({
  crewType: identifier,
  troops: quantity,
  train: quantity.max(100),
  atmos: quantity.max(100),
});
export const cityResourceSchema = z.strictObject({
  gold: quantity,
  rice: quantity,
  garrison: z
    .array(cityGarrisonSchema)
    .refine((rows) => new Set(rows.map((row) => row.crewType)).size === rows.length, '도시 병종이 중복됐습니다.')
    .refine((rows) => {
      let total = 0;
      for (const row of rows) {
        if (row.troops > CITY_RESOURCE_MAX - total) return false;
        total += row.troops;
      }
      return true;
    }, '도시 전체 병력 수량 한도를 넘었습니다.')
    .transform((rows) => rows.sort((left, right) => left.crewType - right.crewType)),
});
export const cityResourcesStateSchema = z.strictObject({
  version: z.literal(1),
  cities: z.record(z.string().regex(/^[1-9]\d*$/), cityResourceSchema),
});

export type CityGarrisonState = z.infer<typeof cityGarrisonSchema>;
export type CityResourceState = z.infer<typeof cityResourceSchema>;
export type CityResourcesState = z.infer<typeof cityResourcesStateSchema>;
type CityWorld = Pick<WorldView, 'cities'>;

// 병종 참조는 현재 월드의 군사 병종 목록을 받은 경계에서 검사한다.
export function readCityResourcesState(
  value: unknown,
  world: CityWorld,
  armyTypes?: readonly number[],
): CityResourcesState {
  const state = cityResourcesStateSchema.parse(value);
  const keys = Object.keys(world.cities);
  if (
    Object.keys(state.cities).length !== keys.length ||
    keys.some((key) => {
      const city = world.cities[Number(key)];
      return !city || String(city.cityKey) !== key || !Object.hasOwn(state.cities, key);
    })
  )
    throw new Error('도시 자원과 월드 거점의 대응이 다릅니다.');
  if (armyTypes !== undefined) {
    const types = z.array(identifier).parse(armyTypes);
    if (new Set(types).size !== types.length) throw new Error('군사 병종 목록이 중복됐습니다.');
    const allowed = new Set(types);
    for (const city of Object.values(state.cities))
      if (city.garrison.some((row) => !allowed.has(row.crewType)))
        throw new Error('도시 수비병의 군사 병종이 없습니다.');
  }
  return state;
}

export function emptyCityResourcesState(world: CityWorld): CityResourcesState {
  return readCityResourcesState(
    {
      version: 1,
      cities: Object.fromEntries(Object.keys(world.cities).map((key) => [key, { gold: 0, rice: 0, garrison: [] }])),
    },
    world,
  );
}
