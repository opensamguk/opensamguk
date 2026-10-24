import type { Prisma } from '@opensamguk/db';
import { findTradeRoutes, toGameDate } from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { requireGeneral, requireWorld } from './queries';
import { checkTreatyRow, requireTreatyWorld, treatyTradeEnabled } from './treatyQueries';

type TradeTarget = {
  cityKey: number;
  cityName: string;
  nation: { id: number; name: string; color: string };
  treatyId: string;
  tradeEndsAt: { year: number; month: number };
};
export type TradeTargets = { fromCityKey: number | null; items: TradeTarget[]; blocked: string | null };

export async function listTradeTargets(
  tx: Prisma.TransactionClient,
  input: { worldId: string; userId: string },
): Promise<TradeTargets> {
  const world = await requireWorld(tx, input.worldId);
  requireTreatyWorld(world);
  if (!treatyTradeEnabled(world))
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '교역 기능을 쓰지 않는 월드입니다.' });
  const actor = await requireGeneral(tx, input.worldId, input.userId);
  const blocked = (message: string): TradeTargets => ({ fromCityKey: actor.cityKey, items: [], blocked: message });
  if (world.status !== 'RUNNING') return blocked('실행 중인 월드가 아닙니다.');
  if (actor.nationId === null) return blocked('국가에 소속되어야 합니다.');
  const nationId = actor.nationId;
  const home = await tx.city.findUnique({
    where: { worldId_cityKey: { worldId: input.worldId, cityKey: actor.cityKey } },
    select: { cityKey: true, nationId: true, connections: true },
  });
  if (!home || home.nationId !== nationId) return blocked('자기 국가 도시에서만 가능합니다.');
  const [cities, nations, diplomacies, rows] = await Promise.all([
    tx.city.findMany({
      where: { worldId: input.worldId, cityKey: { in: home.connections }, nationId: { not: nationId } },
      select: { cityKey: true, name: true, nationId: true },
    }),
    tx.nation.findMany({ where: { worldId: input.worldId }, select: { id: true, name: true, color: true } }),
    tx.diplomacy.findMany({
      where: { worldId: input.worldId, OR: [{ nationA: nationId }, { nationB: nationId }] },
      select: { nationA: true, nationB: true, state: true },
    }),
    tx.treaty.findMany({
      where: { worldId: input.worldId, status: 'ACTIVE', OR: [{ fromNationId: nationId }, { toNationId: nationId }] },
      orderBy: { id: 'asc' },
    }),
  ]);
  const treaties = rows.map((row) => {
    const checked = checkTreatyRow(world, row);
    if (checked.status !== 'ACTIVE' || (checked.fromNationId !== nationId && checked.toNationId !== nationId))
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '교역 조약을 확인하지 못했습니다.' });
    return checked;
  });
  const refs = new Map(nations.map((nation) => [nation.id, { id: nation.id, name: nation.name, color: nation.color }]));
  const routes = findTradeRoutes(
    {
      cities: {
        ...Object.fromEntries(cities.map((city) => [city.cityKey, { nationId: city.nationId, connections: [] }])),
        [home.cityKey]: home,
      },
      nations: Object.fromEntries(refs),
      diplomacies,
      treaties,
    },
    nationId,
    home.cityKey,
    world.clockTick,
  );
  const items = routes.map((route) => {
    const city = cities.find((candidate) => candidate.cityKey === route.cityKey)!;
    const nation = refs.get(city.nationId!)!;
    return {
      cityKey: city.cityKey,
      cityName: city.name,
      nation,
      treatyId: route.treatyId,
      tradeEndsAt: toGameDate(world.startYear, route.endTick),
    };
  });
  return {
    fromCityKey: home.cityKey,
    items,
    blocked: items.length ? null : '교역할 수 있는 조약과 연결 도시가 없습니다.',
  };
}
