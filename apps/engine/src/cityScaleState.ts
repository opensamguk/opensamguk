import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import { checkReplayOrigin, readCityRuins, type WorldView, type CityRuinsState } from '@opensamguk/rules';

type StoredWorld = Pick<
  Prisma.WorldGetPayload<Record<string, never>>,
  'id' | 'ruleFeatures' | 'replayFormat' | 'replayOrigin' | 'cityRuinsState'
>;

export function readStoredCityRuins(
  world: StoredWorld,
  state: Pick<WorldView, 'ruleFeatures' | 'cities'>,
): CityRuinsState | undefined {
  if (!world.ruleFeatures.includes('city-scale-v1')) return readCityRuins(world.cityRuinsState, state);
  const origin: unknown = world.replayOrigin;
  checkReplayOrigin(origin);
  if (world.replayFormat !== 3 || origin.version !== 3 || !origin.initial.ruleFeatures?.includes('city-scale-v1'))
    throw new Error('폐허의 재생 형식이나 생성 원장이 다릅니다.');
  return readCityRuins(world.cityRuinsState, state, origin.initial.cityScale);
}

export async function assertStoredCityRuins(tx: Prisma.TransactionClient, world: StoredWorld): Promise<void> {
  if (!world.ruleFeatures.includes('city-scale-v1')) {
    readStoredCityRuins(world, { cities: {}, ruleFeatures: world.ruleFeatures });
    return;
  }
  const rows = await tx.city.findMany({ where: { worldId: world.id }, omit: { kind: true } });
  readStoredCityRuins(world, {
    cities: Object.fromEntries(rows.map((city) => [city.cityKey, city])),
    ruleFeatures: world.ruleFeatures,
  });
}

// 호출자가 같은 World 행 잠금과 턴 트랜잭션을 유지한다.
export async function persistCityRuins(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
): Promise<void> {
  const original = readCityRuins(before.cityRuins, before);
  const final = readCityRuins(next.cityRuins, next);
  if (!original && !final) return;
  if (!original || !final) throw new Error('진행 중인 월드의 폐허 기능을 추가하거나 지울 수 없습니다.');
  if (isDeepStrictEqual(original, final)) return;
  const changed = await tx.$executeRaw`
    UPDATE "World" SET "cityRuinsState" = ${JSON.stringify(final)}::jsonb
    WHERE id = ${worldId} AND "cityRuinsState" = ${JSON.stringify(original)}::jsonb
  `;
  if (changed !== 1) throw new Error('저장할 폐허 상태가 바뀌었습니다.');
}
