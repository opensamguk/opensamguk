import type { Prisma } from '@opensamguk/db';
import { checkReplayOrigin, readCityRuins, RUIN_PERCENT, type WorldState } from '@opensamguk/rules';

type RuinInfo = { percent: (typeof RUIN_PERCENT)[number] } | null;
type City = Prisma.CityGetPayload<Record<string, never>>;

// 같은 RepeatableRead 조회에서 도시 상한과 원장을 대조한다. 응답에는 복구 비율만 남긴다.
export async function readCityScaleProjection(
  tx: Prisma.TransactionClient,
  worldId: string,
  features: readonly string[],
  cities?: readonly City[],
): Promise<Map<number, RuinInfo> | undefined> {
  if (!features.includes('city-scale-v1')) return undefined;
  const world = await tx.world.findUniqueOrThrow({
    where: { id: worldId },
    select: { ruleFeatures: true, replayFormat: true, replayOrigin: true, cityRuinsState: true },
  });
  const origin: unknown = world.replayOrigin;
  checkReplayOrigin(origin);
  if (world.replayFormat !== 3 || origin.version !== 3 || !origin.initial.ruleFeatures?.includes('city-scale-v1'))
    throw new Error('폐허의 재생 형식이나 생성 원장이 다릅니다.');
  const rows = cities ?? (await tx.city.findMany({ where: { worldId } }));
  const state: Pick<WorldState, 'ruleFeatures' | 'cities'> = {
    ruleFeatures: world.ruleFeatures,
    cities: Object.fromEntries(
      rows.map(({ kind, ...city }): [number, WorldState['cities'][number]] => {
        if (kind !== null && kind !== 'CITY' && kind !== 'PASS') throw new Error('도시 종류가 저장 형식과 다릅니다.');
        return [city.cityKey, { ...city, ...(kind ? { kind } : {}) }];
      }),
    ),
  };
  const ruins = readCityRuins(world.cityRuinsState, state, origin.initial.cityScale);
  if (!ruins) throw new Error('폐허 복구 상태가 없습니다.');
  const active = new Map(ruins.cities.map((row) => [row.cityKey, { percent: RUIN_PERCENT[row.stage] }]));
  return new Map(rows.map((city) => [city.cityKey, active.get(city.cityKey) ?? null]));
}
