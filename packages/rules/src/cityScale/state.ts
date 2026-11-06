import { z } from 'zod';
import type { WorldInit } from '../world/bootstrap';
import type { WorldView } from '../model/world';
import { cityValues } from '../world/resources';
import {
  CITY_SCALE_FEATURE,
  CITY_SCALE_FIELDS,
  cityScaleRecordSchema,
  ruinMaximum,
  WASTELAND_MAX,
  type CityScaleRecord,
} from '../world/map/cityScale';

export const cityRuinsSchema = z.strictObject({
  version: z.literal(1),
  cities: z
    .array(
      z.strictObject({
        cityKey: z.number().int().positive().max(2_147_483_647),
        level: z.number().int().min(0).max(9),
        stage: z.union([z.literal(0), z.literal(1), z.literal(2)]),
        baseMax: cityValues.strict(),
      }),
    )
    .max(300)
    .refine((rows) => rows.every((row, i) => i === 0 || rows[i - 1]!.cityKey < row.cityKey)),
});
export type CityRuinsState = z.infer<typeof cityRuinsSchema>;
export const RUIN_PERCENT = [10, 40, 70] as const;

export function checkCityScaleInitial(initial: Pick<WorldInit, 'ruleFeatures' | 'cityScale' | 'cities'>): void {
  if (Object.hasOwn(initial, 'cityRuins')) throw new Error('폐허 상태는 생성 원장에서 초기화해야 합니다.');
  if (!initial.ruleFeatures?.includes(CITY_SCALE_FEATURE)) {
    if (Object.hasOwn(initial, 'cityScale')) throw new Error('도시 규모 기능을 끈 생성 기록에 규모 원장이 있습니다.');
    return;
  }
  const record = cityScaleRecordSchema.parse(initial.cityScale);
  const cities = new Map(initial.cities.map((city) => [city.cityKey, city]));
  const recorded = new Set(record.cities.map((row) => row.cityKey));
  for (const row of record.cities) {
    const city = cities.get(row.cityKey);
    if (!city || city.kind === 'PASS' || city.level !== row.level)
      throw new Error('도시 규모 원장의 도시나 원래 규모가 다릅니다.');
    if (row.level === 9 && !['낙양', '장안'].includes(city.name))
      throw new Error('경 규모는 낙양과 장안에만 지정할 수 있습니다.');
    const max = row.ruin ? ruinMaximum(row.max, 10) : row.max;
    for (const field of CITY_SCALE_FIELDS)
      if (
        !Number.isSafeInteger(row.max[field]) ||
        row.max[field] > 2_147_483_647 ||
        (row.level === 0 && row.max[field] !== WASTELAND_MAX[field]) ||
        city[`${field}Max`] !== max[field] ||
        city[field] < 0 ||
        city[field] > max[field]
      )
        throw new Error('도시 규모의 최대치나 초기값이 생성 원장과 다릅니다.');
  }
  if (initial.cities.some((city) => city.kind !== 'PASS' && [0, 9].includes(city.level) && !recorded.has(city.cityKey)))
    throw new Error('무·경 도시의 생성 원장이 없습니다.');
}

export function initialCityRuins(initial: WorldInit): CityRuinsState {
  checkCityScaleInitial(initial);
  if (!initial.cityScale) throw new Error('도시 규모 생성 원장이 없습니다.');
  return {
    version: 1,
    cities: initial.cityScale.cities
      .filter((row) => row.ruin)
      .map((row) => ({
        cityKey: row.cityKey,
        level: row.level,
        stage: 0,
        baseMax: { ...row.max },
      })),
  };
}

export function readCityRuins(
  value: unknown,
  world: Pick<WorldView, 'cities' | 'ruleFeatures'>,
  expected?: CityScaleRecord,
): CityRuinsState | undefined {
  if (!world.ruleFeatures?.includes(CITY_SCALE_FEATURE)) {
    if (value !== null && value !== undefined) throw new Error('도시 규모 기능을 끈 월드에 폐허 상태가 있습니다.');
    return undefined;
  }
  const state = cityRuinsSchema.parse(value);
  for (const row of state.cities) {
    const city = world.cities[row.cityKey];
    if (!city || city.kind === 'PASS' || city.level !== row.level)
      throw new Error('폐허의 도시나 원래 규모가 다릅니다.');
    const max = ruinMaximum(row.baseMax, RUIN_PERCENT[row.stage]);
    for (const field of CITY_SCALE_FIELDS)
      if (row.baseMax[field] > 2_147_483_647 || city[`${field}Max`] !== max[field])
        throw new Error('폐허 단계의 최대치가 저장 상태와 다릅니다.');
  }
  if (expected) {
    const remaining = new Map(state.cities.map((row) => [row.cityKey, row]));
    const originals = new Map(expected.cities.filter((row) => row.ruin).map((row) => [row.cityKey, row]));
    for (const row of state.cities) {
      const original = originals.get(row.cityKey);
      if (
        !original ||
        row.level !== original.level ||
        CITY_SCALE_FIELDS.some((field) => row.baseMax[field] !== original.max[field])
      )
        throw new Error('폐허의 원래 규모나 최대치가 생성 원장과 다릅니다.');
    }
    for (const row of originals.values())
      if (!remaining.has(row.cityKey)) {
        const city = world.cities[row.cityKey];
        if (
          !city ||
          city.level !== row.level ||
          CITY_SCALE_FIELDS.some((field) => city[`${field}Max`] !== row.max[field])
        )
          throw new Error('폐허가 해제된 도시의 최대치가 생성 원장과 다릅니다.');
      }
  }
  return state;
}
