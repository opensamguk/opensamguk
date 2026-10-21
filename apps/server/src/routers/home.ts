import { protectedProcedure, router } from '../trpc';
import { nextTurnAt, readWorld, requireGeneral, worldInput } from '../queries';
import { cityInfo, ownGeneralInfo, logInfo, logSelect, nationInfo } from '../visibility';

export const homeRouter = router({
  get: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      const city = await tx.city.findUniqueOrThrow({
        where: { worldId_cityKey: { worldId: input.worldId, cityKey: general.cityKey } },
      });
      const nation =
        general.nationId === null
          ? null
          : await tx.nation.findUniqueOrThrow({
              where: { worldId_id: { worldId: input.worldId, id: general.nationId } },
              include: { _count: { select: { cities: true, generals: true } } },
            });
      const turns = await tx.generalTurn.findMany({
        where: { worldId: input.worldId, generalId: general.id, slot: { lt: 5 } },
        orderBy: { slot: 'asc' },
        select: { slot: true, commandKey: true, args: true },
      });
      const logs = await tx.generalLog.findMany({
        where: { worldId: input.worldId, generalId: general.id },
        orderBy: { tick: 'desc' },
        take: 10,
        select: logSelect,
      });
      return {
        general: ownGeneralInfo(general),
        city: cityInfo(city, general),
        nation:
          nation === null
            ? null
            : nationInfo(
                nation,
                {
                  cityCount: nation._count.cities,
                  generalCount: nation._count.generals,
                },
                general,
              ),
        nextTurnAt: nextTurnAt(world, general.nextTurnTick),
        turnsPreview: Array.from(
          { length: 5 },
          (_, slot) => turns.find((turn) => turn.slot === slot) ?? { slot, commandKey: 'rest', args: {} },
        ),
        recentLogs: logs.map(logInfo),
      };
    }),
  ),
});
