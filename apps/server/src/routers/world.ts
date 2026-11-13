import { z } from 'zod';
import type { Prisma } from '@opensamguk/db';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import { readWorld, worldInput, worldSummary } from '../queries';
import { mapCity, publicMapInfo } from '../visibility';
import { cityRegionName, readOperationalMap, operationalMapDisplay } from '@opensamguk/rules';
import { readCityScaleProjection } from '../game/cityScale';
import { readMapBackgrounds } from '../resourceAdmin/mapBackground';

export const worldRouter = router({
  publicMaps: publicProcedure.input(z.void()).query(async ({ ctx }) => {
    const { delayMinutes } = ctx.publicMapConfig;
    const initial = {
      tick: 0,
      takenAt: { lte: new Date(ctx.now) },
      data: { path: ['initial'], equals: true },
    } satisfies Prisma.PublicMapSnapshotWhereInput;
    const worlds = await ctx.db.world.findMany({
      where: {
        OR: [{ status: { in: ['RUNNING', 'PAUSED'] } }, { status: 'PREOPEN', publicMaps: { some: initial } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        status: true,
        mapKey: true,
        publicMaps: {
          where: { OR: [initial, { takenAt: { lte: new Date(ctx.now - delayMinutes * 60_000) } }] },
          orderBy: { takenAt: 'desc' },
          take: 1,
          select: { takenAt: true, year: true, month: true, data: true },
        },
      },
    });
    const backgrounds = await readMapBackgrounds(
      ctx.db,
      worlds.map((world) => world.mapKey),
    );
    return {
      delayMinutes,
      worlds: worlds.map(({ id, name, status, mapKey, publicMaps }) => {
        const snapshot = publicMaps[0];
        const data = snapshot && publicMapInfo(snapshot.data);
        return {
          id,
          name,
          status: status as 'PREOPEN' | 'RUNNING' | 'PAUSED',
          background: backgrounds.get(mapKey) ?? null,
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
        select: { id: true, name: true, color: true, capitalCityKey: true },
      });
      const world = await tx.world.findUniqueOrThrow({
        where: { id: input.worldId },
        select: { operationalMap: true, ruleFeatures: true, replayOrigin: true, mapKey: true },
      });
      const map = readOperationalMap(world.operationalMap, world.ruleFeatures, world.replayOrigin);
      const ruins = await readCityScaleProjection(tx, input.worldId, world.ruleFeatures, cities);
      const backgrounds = await readMapBackgrounds(tx, [world.mapKey]);
      return {
        background: backgrounds.get(world.mapKey) ?? null,
        cities: cities.map((city) => ({
          ...mapCity(city),
          region: city.region,
          regionName: cityRegionName(city.region, world.mapKey, map?.regionScheme),
          ...(ruins ? { ruin: ruins.get(city.cityKey) ?? null } : {}),
        })),
        nations,
        ...(map ? { operationalMap: operationalMapDisplay(map) } : {}),
      };
    }),
  ),
});
