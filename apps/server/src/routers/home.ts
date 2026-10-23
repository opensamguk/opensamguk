import { protectedProcedure, router } from '../trpc';
import { nextTurnAt, readWorld, requireGeneral, worldInput } from '../queries';
import { cityInfo, ownGeneralInfo, logInfo, logSelect, nationInfo } from '../visibility';
import { policyOptions } from '@opensamguk/rules';
import { displaySlots, readSlots } from '../game/slots';

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
      const turns = displaySlots(await readSlots(tx, input.worldId, general.id));
      const logs = await tx.generalLog.findMany({
        where: { worldId: input.worldId, generalId: general.id },
        orderBy: { tick: 'desc' },
        take: 10,
        select: logSelect,
      });
      return {
        general: {
          ...ownGeneralInfo(general),
          policy: (() => {
            const option = policyOptions().find((entry) => entry.key === (general.defaultPolicy ?? 'none'))!;
            return { key: option.key, name: option.name };
          })(),
        },
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
        turnsPreview: Array.from({ length: 5 }, (_, slot) => ({ slot, ...turns[slot]! })),
        recentLogs: logs.map(logInfo),
      };
    }),
  ),
});
