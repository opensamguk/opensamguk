import { protectedProcedure, router } from '../trpc';
import { page, readWorld, recordsInput } from '../queries';
import { publicNationDisplaySelect, timelapseFrameInfo } from '../visibility';

export const timelapseRouter = router({
  frames: protectedProcedure.input(recordsInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const history = await tx.yearbookSnapshot.findMany({
        where: {
          worldId: input.worldId,
          ...(input.cursor === undefined ? {} : { tick: { gt: Number(input.cursor) } }),
        },
        orderBy: { tick: 'asc' },
        take: 31,
        select: { tick: true, year: true, month: true, data: true },
      });
      // 다음 페이지 확인용 31번째 행은 파싱하지 않는다.
      const result = page(history);
      const items = result.items.map((row) => ({
        tick: row.tick,
        year: row.year,
        month: row.month,
        ...timelapseFrameInfo(row.data),
      }));
      const nationIds = [
        ...new Set(
          items.flatMap((frame) => frame.cities.flatMap(({ nationId }) => (nationId === null ? [] : [nationId]))),
        ),
      ];
      const currentNations =
        nationIds.length === 0
          ? []
          : await tx.nation.findMany({
              where: { worldId: input.worldId, id: { in: nationIds } },
              orderBy: { id: 'asc' },
              select: publicNationDisplaySelect,
            });
      return { items, currentNations, nextCursor: result.nextCursor };
    }),
  ),
});
