import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import { readWorld, worldInput, worldSummary } from '../queries';
import { mapCity, publicMapInfo } from '../visibility';
import { readOperationalMap, operationalMapDisplay } from '@opensamguk/rules';

export const worldRouter = router({
  publicMaps: publicProcedure.input(z.void()).query(async ({ ctx }) => {
    const { delayMinutes } = ctx.publicMapConfig;
    const worlds = await ctx.db.world.findMany({
      where: { status: { in: ['RUNNING', 'PAUSED'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        status: true,
        publicMaps: {
          where: { takenAt: { lte: new Date(ctx.now - delayMinutes * 60_000) } },
          orderBy: { takenAt: 'desc' },
          take: 1,
          select: { takenAt: true, year: true, month: true, data: true },
        },
      },
    });
    return {
      delayMinutes,
      worlds: worlds.map(({ id, name, status, publicMaps }) => {
        const snapshot = publicMaps[0];
        const data = snapshot && publicMapInfo(snapshot.data);
        return {
          id,
          name,
          status: status as 'RUNNING' | 'PAUSED',
          map:
            snapshot && data
              ? { takenAt: snapshot.takenAt.toISOString(), year: snapshot.year, month: snapshot.month, ...data }
              : null,
        };
      }),
    };
  }),
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
      const world = await tx.world.findUniqueOrThrow({
        where: { id: input.worldId },
        select: { operationalMap: true, ruleFeatures: true, replayOrigin: true },
      });
      const map = readOperationalMap(world.operationalMap, world.ruleFeatures, world.replayOrigin);
      return { cities: cities.map(mapCity), nations, ...(map ? { operationalMap: operationalMapDisplay(map) } : {}) };
    }),
  ),
});
