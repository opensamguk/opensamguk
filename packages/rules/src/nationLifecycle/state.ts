import { z } from 'zod';
import type { WorldView } from '../model/world';
import type { InitialNation, WorldInit } from '../world/bootstrap';

export const NATION_LIFECYCLE_FEATURE = 'nation-lifecycle-v1';
export const WANDERING_MONTH_LIMIT = 24;
export const DISBAND_PERSONAL_LIMIT = 1000;

export const nationLifecycleSchema = z.strictObject({
  version: z.literal(1),
  nations: z.record(
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .refine((key) => Number.isSafeInteger(Number(key))),
    z.strictObject({ sinceTick: z.number().int().min(0).max(2_147_483_647) }),
  ),
});
export type NationLifecycleState = z.infer<typeof nationLifecycleSchema>;
export const initialNationLifecycle = (
  nations: readonly Pick<InitialNation, 'id' | 'capitalCityKey'>[] = [],
): NationLifecycleState => ({
  version: 1,
  nations: Object.fromEntries(
    nations.filter((nation) => nation.capitalCityKey === null).map(({ id }) => [id, { sinceTick: 0 }]),
  ),
});

export function assertInitialNationLifecycle(initial: Pick<WorldInit, 'nations' | 'cities'>, enabled: boolean) {
  if (initial.nations.some((nation) => nation.capitalCityKey === null) && !enabled)
    throw new Error('시작 방랑 국가에는 형식 3의 국가 변천 기능이 필요합니다.');
  if (!enabled) return;
  for (const nation of initial.nations) {
    const ownsCities = initial.cities.some((city) => city.nationId === nation.id);
    const hasCapital = nation.capitalCityKey !== null;
    if (hasCapital !== ownsCities) throw new Error('시작 방랑 국가의 수도와 소유 도시가 다릅니다.');
  }
}

export function readNationLifecycle(value: unknown, world: Pick<WorldView, 'ruleFeatures'>) {
  if (!world.ruleFeatures?.includes(NATION_LIFECYCLE_FEATURE)) {
    if (value != null) throw new Error('방랑 기능을 끈 월드에 국가 변천 상태가 있습니다.');
    return undefined;
  }
  return nationLifecycleSchema.parse(value);
}

export function isWandering(world: Pick<WorldView, 'ruleFeatures' | 'nationLifecycle'>, nationId: number | null) {
  return (
    world.ruleFeatures?.includes(NATION_LIFECYCLE_FEATURE) === true &&
    nationId !== null &&
    Object.hasOwn(world.nationLifecycle?.nations ?? {}, String(nationId))
  );
}

export function assertNationLifecycle(world: WorldView): void {
  const state = readNationLifecycle(world.nationLifecycle, world);
  if (Object.values(world.nations).some((nation) => nation.capitalCityKey === null && !isWandering(world, nation.id)))
    throw new Error('수도가 없는 국가의 방랑 원장이 없습니다.');
  if (!state) return;
  for (const key of Object.keys(state.nations)) {
    const nationId = Number(key);
    if (!world.nations[nationId]) throw new Error('방랑 원장의 국가가 없습니다.');
    if (Object.values(world.cities).some((city) => city.nationId === nationId))
      throw new Error('방랑 국가가 도시를 소유하고 있습니다.');
  }
}
