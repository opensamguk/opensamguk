import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import { readCityResourcesState, type CityResourcesState, type WorldView } from '@opensamguk/rules';
import { readCampaignArmyTypes } from './campaignState';

type CityWorld = Pick<WorldView, 'cities' | 'ruleFeatures'>;

// 같은 World 행 잠금을 가진 호출자가 저장 순서와 트랜잭션을 관리한다.
export function readStoredCityResources(
  value: unknown,
  world: CityWorld,
  armyTypes: readonly number[],
): CityResourcesState | undefined {
  if (!world.ruleFeatures?.includes('city-resources-v1')) {
    if (value !== null && value !== undefined) throw new Error('도시 자원 기능을 끈 월드에 저장 상태가 있습니다.');
    return undefined;
  }
  if (!world.ruleFeatures.includes('campaign-v1') || !world.ruleFeatures.includes('campaign-assignment-v2'))
    throw new Error('도시 자원의 휘하 기능 의존 관계가 없습니다.');
  return readCityResourcesState(value, world, armyTypes);
}

// exportReplay는 loadWorld를 거치지 않으므로 원장과 현재 거점·병종도 따로 대조한다.
export async function assertStoredCityResources(
  tx: Prisma.TransactionClient,
  world: Pick<
    Prisma.WorldGetPayload<Record<string, never>>,
    'id' | 'replayFormat' | 'ruleFeatures' | 'replayOrigin' | 'unitSet' | 'cityResourcesState'
  >,
): Promise<void> {
  if (!world.ruleFeatures.includes('city-resources-v1')) {
    readStoredCityResources(world.cityResourcesState, { cities: {}, ruleFeatures: world.ruleFeatures }, []);
    return;
  }
  if (world.replayFormat !== 3) throw new Error('도시 자원은 새 판 재생 형식에서만 쓸 수 있습니다.');
  const cities = await tx.city.findMany({ where: { worldId: world.id }, omit: { kind: true } });
  readStoredCityResources(
    world.cityResourcesState,
    {
      cities: Object.fromEntries(cities.map((city) => [city.cityKey, city])),
      ruleFeatures: world.ruleFeatures,
    },
    readCampaignArmyTypes(world),
  );
}

export async function persistCityResourcesState(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
  armyTypes: readonly number[],
): Promise<void> {
  const original = readStoredCityResources(before.cityResources, before, armyTypes);
  const final = readStoredCityResources(next.cityResources, next, armyTypes);
  if (!original && !final) return;
  if (!original || !final) throw new Error('진행 중인 월드의 도시 자원을 추가하거나 지울 수 없습니다.');
  if (isDeepStrictEqual(original, final)) return;
  const changed = await tx.$executeRaw`
    UPDATE "World" SET "cityResourcesState" = ${JSON.stringify(final)}::jsonb
    WHERE id = ${worldId} AND "cityResourcesState" = ${JSON.stringify(original)}::jsonb
  `;
  if (changed !== 1) throw new Error('저장할 도시 자원 상태가 바뀌었습니다.');
}
