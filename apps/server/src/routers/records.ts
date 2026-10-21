import { protectedProcedure, router } from '../trpc';
import { beforeCursor, page, readWorld, recordsInput, requireGeneral } from '../queries';
import { logInfo, logSelect, nationRecordInfo, worldRecordInfo } from '../visibility';

export const recordsRouter = router({
  general: protectedProcedure.input(recordsInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      const logs = await tx.generalLog.findMany({
        where: { worldId: input.worldId, generalId: general.id, ...beforeCursor(input.cursor) },
        orderBy: { tick: 'desc' },
        take: 31,
        select: logSelect,
      });
      return page(logs.map(logInfo));
    }),
  ),
  nation: protectedProcedure.input(recordsInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      if (general.nationId === null) return { items: [], nextCursor: null };
      const history = await tx.nationHistory.findMany({
        where: { worldId: input.worldId, nationId: general.nationId, ...beforeCursor(input.cursor) },
        orderBy: { tick: 'desc' },
        take: 31,
        select: { tick: true, data: true },
      });
      return page(history.map((row) => ({ tick: row.tick, ...nationRecordInfo(row.data) })));
    }),
  ),
  world: protectedProcedure.input(recordsInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const history = await tx.yearbookSnapshot.findMany({
        where: { worldId: input.worldId, ...beforeCursor(input.cursor) },
        orderBy: { tick: 'desc' },
        take: 31,
        select: { tick: true, year: true, month: true, data: true },
      });
      return page(
        history.map((row) => ({
          tick: row.tick,
          year: row.year,
          month: row.month,
          ...worldRecordInfo(row.data),
        })),
      );
    }),
  ),
});
