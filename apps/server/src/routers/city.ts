import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { entityKey, readWorld, viewerGeneral, worldInput } from '../queries';
import { cityInfo, garrisonGeneralInfo, visibility } from '../visibility';
import { readView } from '../game/queries';
import { cityRegionName, INTEL_FEATURE, LINEAGE_EXITED_YEAR, readOperationalMap } from '@opensamguk/rules';
import { readCityScaleProjection } from '../game/cityScale';
import { readCityIntel } from '../game/fog';

export const cityRouter = router({
  get: protectedProcedure.input(worldInput.extend({ cityKey: entityKey }).strict()).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const fogEnabled = world.ruleFeatures.includes(INTEL_FEATURE);
      const general = await viewerGeneral(tx, input.worldId, ctx.user.id);
      const viewer = fogEnabled && general?.removedAt != null ? null : general;
      const city = await tx.city.findUnique({
        where: { worldId_cityKey: input },
        include: { world: { select: { mapKey: true, operationalMap: true } } },
      });
      if (!city) throw new TRPCError({ code: 'NOT_FOUND', message: '도시를 찾을 수 없습니다.' });
      const garrisonHidden = fogEnabled && city.nationId !== null && viewer?.nationId !== city.nationId;
      const generals = garrisonHidden
        ? []
        : await tx.general.findMany({
            where: {
              worldId: input.worldId,
              cityKey: input.cityKey,
              removedAt: null,
              activeFromYear: { not: LINEAGE_EXITED_YEAR },
            },
            orderBy: { id: 'asc' },
          });
      const campaignEnabled = world.ruleFeatures.includes('campaign-v1');
      const units =
        campaignEnabled && !garrisonHidden ? (await readView(tx, input.worldId)).campaign!.units : undefined;
      const ruins = await readCityScaleProjection(tx, input.worldId, world.ruleFeatures);
      const intel =
        fogEnabled && viewer?.nationId != null && !visibility(viewer).city(city)
          ? await readCityIntel(tx, world, viewer.nationId, city.cityKey, ctx)
          : null;
      return {
        ...cityInfo(city, viewer),
        regionName: cityRegionName(
          city.region,
          city.world.mapKey,
          readOperationalMap(city.world.operationalMap, world.ruleFeatures)?.regionScheme,
        ),
        ...(ruins ? { ruin: ruins.get(city.cityKey) ?? null } : {}),
        ...(campaignEnabled ? { campaignEnabled: true as const } : {}),
        ...(world.ruleFeatures.includes('five-stats') ? { fiveStats: true as const } : {}),
        ...(fogEnabled ? { fog: { intel, garrisonHidden } } : {}),
        generals: generals.map((general) => garrisonGeneralInfo(general, viewer, units)),
      };
    }),
  ),
});
