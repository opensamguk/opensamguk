import { z } from 'zod';
import type { WorldView } from '../model/world';

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
export const initialNationLifecycle = (): NationLifecycleState => ({ version: 1, nations: {} });

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
  if (!state) return;
  for (const key of Object.keys(state.nations)) {
    const nationId = Number(key);
    if (!world.nations[nationId]) throw new Error('방랑 원장의 국가가 없습니다.');
    if (Object.values(world.cities).some((city) => city.nationId === nationId))
      throw new Error('방랑 국가가 도시를 소유하고 있습니다.');
  }
}
