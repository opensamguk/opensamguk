import type { Prisma } from '@opensamguk/db';
import {
  toGameDate,
  readOperationalMap,
  operationalMapDisplay,
  readCityRuins,
  RUIN_PERCENT,
  type OperationalMapResource,
  type WorldState,
} from '@opensamguk/rules';
import type { PublicMapConfig } from '@opensamguk/shared';
import { assertLease, lockLease, type Lease } from './lease';

function publicMapData(state: WorldState, map?: OperationalMapResource) {
  const ruins = readCityRuins(state.cityRuins, state);
  const recovery = new Map(ruins?.cities.map((row) => [row.cityKey, { percent: RUIN_PERCENT[row.stage] }]));
  return {
    capitalAndSupply: true,
    ...(map ? { operationalMap: operationalMapDisplay(map) } : {}),
    cities: Object.values(state.cities)
      .sort((a, b) => a.cityKey - b.cityKey)
      .map((city) => ({
        key: String(city.cityKey),
        name: city.name,
        level: city.level,
        ...(city.kind ? { kind: city.kind } : {}),
        ...(ruins ? { ruin: recovery.get(city.cityKey) ?? null } : {}),
        x: city.x,
        y: city.y,
        nationId: city.nationId,
        supplied: city.supplied,
        links: city.connections.map(String),
      })),
    nations: Object.values(state.nations)
      .sort((a, b) => a.id - b.id)
      .map(({ id, name, color, capitalCityKey }) => ({ id, name, color, capitalCityKey })),
  };
}

export async function persistInitialPublicMap(
  tx: Prisma.TransactionClient,
  world: { id: string; createdAt: Date },
  state: WorldState,
  map?: OperationalMapResource,
) {
  await tx.publicMapSnapshot.create({
    data: {
      worldId: world.id,
      takenAt: world.createdAt,
      tick: 0,
      ...toGameDate(state.startYear, 0),
      data: { ...publicMapData(state, map), initial: true },
    },
  });
}

// 턴과 같은 트랜잭션에서 저장과 오래된 사본 정리를 함께 반영한다.
export async function persistPublicMap(
  tx: Prisma.TransactionClient,
  lease: Lease,
  state: WorldState,
  tick: number,
  now: number,
  config: PublicMapConfig,
  lockedRunningWorld?: { worldId: string; status: 'RUNNING' },
): Promise<boolean> {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime()))
    throw new Error('공개 지도 기록 시각을 확인하세요.');
  const { worldId } = lease;
  // TurnLoop는 같은 tx에서 리스·World를 잠그고 RUNNING 조건부 갱신을 마쳤다.
  // 단독 호출은 기존 잠금과 상태 검사를 모두 거친다. commit 직전 리스 검사는 유지한다.
  if (lockedRunningWorld) {
    if (lockedRunningWorld.worldId !== worldId || lockedRunningWorld.status !== 'RUNNING')
      throw new Error('잠긴 공개 지도 월드가 다릅니다.');
  } else {
    await lockLease(tx, lease);
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
    const world = await tx.world.findUniqueOrThrow({ where: { id: worldId }, select: { status: true } });
    if (world.status !== 'RUNNING') return false;
  }
  const latest = await tx.publicMapSnapshot.findFirst({
    where: { worldId },
    orderBy: { takenAt: 'desc' },
    select: { takenAt: true },
  });
  if (latest && now - latest.takenAt.getTime() < config.intervalMinutes * 60_000) return false;
  const geography = state.ruleFeatures?.includes('operational-map')
    ? await tx.world.findUniqueOrThrow({
        where: { id: worldId },
        select: { operationalMap: true, ruleFeatures: true, replayOrigin: true },
      })
    : null;
  const map = geography
    ? readOperationalMap(geography.operationalMap, geography.ruleFeatures, geography.replayOrigin)
    : undefined;
  await tx.publicMapSnapshot.create({
    data: {
      worldId,
      takenAt: new Date(now),
      tick,
      ...toGameDate(state.startYear, tick),
      data: publicMapData(state, map),
    },
  });
  const anchor = await tx.publicMapSnapshot.findFirst({
    where: { worldId, takenAt: { lte: new Date(now - config.delayMinutes * 60_000) } },
    orderBy: { takenAt: 'desc' },
    select: { takenAt: true },
  });
  if (anchor) await tx.publicMapSnapshot.deleteMany({ where: { worldId, takenAt: { lt: anchor.takenAt } } });
  await assertLease(tx, lease);
  return true;
}
