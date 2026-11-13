import { z } from 'zod';
import type { Prisma } from '@opensamguk/db';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import { countHumanGenerals, readWorld, viewerGeneral, worldClock, worldInput, worldSummary } from '../queries';
import { mapCity, publicMapInfo } from '../visibility';
import { cityEvents } from '../game/cityEvents';
import {
  cityRegionName,
  HUMAN_GENERAL_LIMIT,
  INTEL_FEATURE,
  NATION_RESTRICTIONS_FEATURE,
  nationRestrictions,
  storedNationRestrictions,
  LINEAGE_EXITED_YEAR,
  RESEARCH_ERA_FEATURE,
  researchEra,
  readOperationalMap,
  operationalMapDisplay,
  effectiveWorldOptions,
  parsePreset,
  parseResourceKey,
  resourceKeySchema,
  scenarioIdentitySchema,
  TICKS_PER_MONTH,
  toGameDate,
  nowTick,
} from '@opensamguk/rules';
import { readCityScaleProjection } from '../game/cityScale';
import { readMapBackgrounds } from '../resourceAdmin/mapBackground';
import { countEngineHealth } from '../ops/health';

const scenarioProgress = scenarioIdentitySchema.extend({ fiction: z.union([z.literal(0), z.literal(1)]).optional() });

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
  summary: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const summary = worldSummary(world, ctx.now);
      const scenarioKey = resourceKeySchema.safeParse(world.scenarioKey);
      const scenarioRef = scenarioKey.success ? parseResourceKey(scenarioKey.data) : null;
      const [humans, npcCount, heartbeat, resource] = await Promise.all([
        countHumanGenerals(tx, world.id),
        tx.general.count({
          where: { worldId: world.id, removedAt: null, userId: null },
        }),
        tx.engineHeartbeat.findUnique({
          where: { worldId: world.id },
          select: { at: true, lastTick: true, lagMs: true },
        }),
        scenarioRef
          ? tx.gameResource.findUnique({
              where: { kind_name_version: { kind: 'SCENARIO', ...scenarioRef }, status: 'PUBLISHED' },
              select: { content: true },
            })
          : null,
      ]);
      const scenario = scenarioProgress.safeParse(resource?.content).data;
      const preset = world.preset === null ? null : parsePreset(world.preset);
      const protection = effectiveWorldOptions(preset, world.runtimeOptions).presetRules?.protection;
      const currentMonth = Math.floor(summary.nowTick / TICKS_PER_MONTH);
      const remaining = (months: number) =>
        world.status === 'ENDED' || months <= currentMonth
          ? null
          : { remainingMonths: months - currentMonth, endsAt: toGameDate(world.startYear, months * TICKS_PER_MONTH) };
      const technologyEra = world.ruleFeatures.includes(RESEARCH_ERA_FEATURE)
        ? researchEra(world.startYear, summary.gameDate.year)
        : undefined;
      const engineActive = world.status === 'RUNNING' || world.status === 'PAUSED';
      const health = engineActive ? countEngineHealth(ctx.now, [{ engineHeartbeat: heartbeat }]) : null;
      return {
        ...summary,
        quota: { humans, max: HUMAN_GENERAL_LIMIT },
        ...(technologyEra ? { technologyEra } : {}),
        npcCount,
        scenarioType:
          scenario?.fiction === 0 ? ('historical' as const) : scenario?.fiction === 1 ? ('fictional' as const) : null,
        serverTime: new Date(ctx.now).toISOString(),
        engine: heartbeat
          ? { heartbeatAt: heartbeat.at.toISOString(), lastTick: heartbeat.lastTick, lagMs: heartbeat.lagMs }
          : null,
        engineStale: health === null ? null : health.stale > 0,
        protection: {
          war: remaining(protection?.peaceMonths ?? 0),
          founding: remaining(protection?.foundUntilMonths ?? 0),
        },
      };
    }),
  ),
  map: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, worldInfo) => {
      const cities = await tx.city.findMany({ where: { worldId: input.worldId }, orderBy: { cityKey: 'asc' } });
      const nations = await tx.nation.findMany({
        where: { worldId: input.worldId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          name: true,
          color: true,
          capitalCityKey: true,
          description: true,
          recruitmentNotice: true,
          restrictions: true,
        },
      });
      const world = await tx.world.findUniqueOrThrow({
        where: { id: input.worldId },
        select: { operationalMap: true, ruleFeatures: true, replayOrigin: true, mapKey: true },
      });
      const map = readOperationalMap(world.operationalMap, world.ruleFeatures, world.replayOrigin);
      const fogEnabled = worldInfo.ruleFeatures.includes(INTEL_FEATURE);
      const viewer = fogEnabled ? await viewerGeneral(tx, input.worldId, ctx.user.id) : null;
      const ownNation = viewer?.removedAt === null ? viewer.nationId : null;
      const tick =
        worldInfo.status === 'ENDED'
          ? (worldInfo.result?.endedTick ?? worldInfo.clockTick)
          : nowTick(worldClock(worldInfo), ctx.now);
      const generals = await tx.general.findMany({
        where: {
          worldId: input.worldId,
          removedAt: null,
          activeFromYear: { not: LINEAGE_EXITED_YEAR },
          ...(fogEnabled
            ? {
                cityKey: {
                  in: cities
                    .filter((city) => city.nationId === null || city.nationId === ownNation)
                    .map((city) => city.cityKey),
                },
              }
            : {}),
        },
        orderBy: { id: 'asc' },
        select: { id: true, name: true, cityKey: true, nationId: true, portraitId: true, userId: true },
      });
      const ruins = await readCityScaleProjection(tx, input.worldId, world.ruleFeatures, cities);
      const backgrounds = await readMapBackgrounds(tx, [world.mapKey]);
      return {
        background: backgrounds.get(world.mapKey) ?? null,
        cities: cities.map((city) => {
          const events =
            !fogEnabled || city.nationId === null || city.nationId === ownNation ? cityEvents(city, tick) : [];
          return {
            ...mapCity(city),
            region: city.region,
            regionName: cityRegionName(city.region, world.mapKey, map?.regionScheme),
            ...(events.length ? { events } : {}),
            ...(ruins ? { ruin: ruins.get(city.cityKey) ?? null } : {}),
          };
        }),
        nations: nations.map(({ recruitmentNotice, restrictions, ...nation }) => ({
          ...nation,
          ...(world.ruleFeatures.includes(NATION_RESTRICTIONS_FEATURE)
            ? {
                recruitmentBlocked: nationRestrictions(world, storedNationRestrictions(true, restrictions))
                  .recruitmentBlocked,
              }
            : {}),
          ...(recruitmentNotice ? { recruitmentNotice } : {}),
        })),
        generals: generals.map(({ userId, ...general }) => ({ ...general, isHuman: userId !== null })),
        ...(map ? { operationalMap: operationalMapDisplay(map) } : {}),
      };
    }),
  ),
});
