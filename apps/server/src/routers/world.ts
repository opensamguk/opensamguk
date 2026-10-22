import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { readWorld, worldInput, worldSummary } from '../queries';
import { mapCity } from '../visibility';

export const worldRouter = router({
  list: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const worlds = await ctx.db.world.findMany({
      where: { status: 'RUNNING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, status: true },
    });
    return { worlds };
  }),
  summary: protectedProcedure
    .input(worldInput)
    .query(({ ctx, input }) => readWorld(ctx.db, input.worldId, async (_tx, world) => worldSummary(world, ctx.now))),
  map: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const cities = await tx.city.findMany({ where: { worldId: input.worldId }, orderBy: { cityKey: 'asc' } });
      const nations = await tx.nation.findMany({
        where: { worldId: input.worldId },
        orderBy: { id: 'asc' },
        select: { id: true, name: true, color: true },
      });
      return { cities: cities.map(mapCity), nations };
    }),
  ),
});
