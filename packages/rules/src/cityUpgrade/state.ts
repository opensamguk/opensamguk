import type { WorldView } from '../model/world';
import { z } from 'zod';
import type { WorldInit } from '../world/bootstrap';
export const CITY_UPGRADE_FEATURE = 'city-upgrade-v1';
export const cityUpgradeConfigSchema = z.strictObject({ version: z.literal(1), enabled: z.boolean() });
const key = z.string().regex(/^[1-9]\d*$/);
const signed = z.number().int().min(-2_147_483_647).max(2_147_483_647);
const increaseSchema = z.strictObject({
  population: signed,
  agriculture: signed,
  commerce: signed,
  security: signed,
  defence: signed,
  wall: signed,
});
const level = z.number().int().min(1).max(9);
export const cityUpgradeStateSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  originalLevels: z.record(key, level),
  completed: z.record(
    key,
    z.strictObject({
      fromLevel: level,
      level,
      outsideSlots: z.array(z.string().min(1)),
      increase: increaseSchema,
    }),
  ),
});
export function initialCityUpgrade(initial: WorldInit, data: unknown) {
  const config = cityUpgradeConfigSchema.parse(data);
  return cityUpgradeStateSchema.parse({
    ...config,
    originalLevels: Object.fromEntries(
      initial.cities
        .filter((city) => !['PASS', 'PORT', 'FIELD'].includes(city.kind ?? '') && city.level > 0)
        .map((city) => [
          city.cityKey,
          initial.cityScale?.cities.find((row) => row.cityKey === city.cityKey)?.level ?? city.level,
        ]),
    ),
    completed: {},
  });
}

export function readCityUpgrade(value: unknown, world: Pick<WorldView, 'cities'>) {
  const state = cityUpgradeStateSchema.parse(value);
  for (const [key, row] of Object.entries(state.completed)) {
    const city = world.cities[Number(key)];
    if (
      !city ||
      ['PASS', 'PORT', 'FIELD'].includes(city.kind ?? '') ||
      city.level !== row.level ||
      row.fromLevel !== state.originalLevels[key] ||
      row.fromLevel > row.level
    )
      throw new Error('승격 완료 기록의 거점·등급이 다릅니다.');
  }
  return state;
}
