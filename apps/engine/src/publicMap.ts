import type { Prisma } from '@opensamguk/db';
import { toGameDate, type WorldState } from '@opensamguk/rules';
import type { PublicMapConfig } from '@opensamguk/shared';
import { assertLease, lockLease, type Lease } from './lease';

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
  const date = toGameDate(state.startYear, tick);
  await tx.publicMapSnapshot.create({
    data: {
      worldId,
      takenAt: new Date(now),
      tick,
      ...date,
      data: {
        cities: Object.values(state.cities)
          .sort((a, b) => a.cityKey - b.cityKey)
          .map((city) => ({
            key: String(city.cityKey),
            name: city.name,
            level: city.level,
            x: city.x,
            y: city.y,
            nationId: city.nationId,
            links: city.connections.map(String),
          })),
        nations: Object.values(state.nations)
          .sort((a, b) => a.id - b.id)
          .map(({ id, name, color }) => ({ id, name, color })),
      },
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
