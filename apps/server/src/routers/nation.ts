import { TRPCError } from '@trpc/server';
import { TICKS_PER_MONTH, WANDERING_MONTH_LIMIT } from '@opensamguk/rules';
import { protectedProcedure, router } from '../trpc';
import { entityKey, readWorld, viewerGeneral, worldInput } from '../queries';
import { garrisonGeneralInfo, mapCity, nationInfo, visibility } from '../visibility';
import { readView } from '../game/queries';

export const nationRouter = router({
  get: protectedProcedure.input(worldInput.extend({ nationId: entityKey }).strict()).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const viewer = await viewerGeneral(tx, input.worldId, ctx.user.id);
      const nation = await tx.nation.findUnique({
        where: { worldId_id: { worldId: input.worldId, id: input.nationId } },
      });
      if (!nation) throw new TRPCError({ code: 'NOT_FOUND', message: '국가를 찾을 수 없습니다.' });
      const cities = await tx.city.findMany({
        where: input,
        orderBy: visibility(viewer).nation(nation)
          ? [{ region: 'asc' }, { level: 'desc' }, { cityKey: 'asc' }]
          : { cityKey: 'asc' },
      });
      const generals = await tx.general.findMany({ where: input, orderBy: { id: 'asc' } });
      const state = world.ruleFeatures.some((feature) => ['campaign-v1', 'nation-lifecycle-v1'].includes(feature))
        ? await readView(tx, input.worldId)
        : undefined;
      const units = state?.campaign?.units;
      const lifecycle = state?.nationLifecycle;
      const wandering = lifecycle?.nations[String(nation.id)];
      return {
        ...(lifecycle
          ? {
              nationLifecycleEnabled: true as const,
              wandering: wandering
                ? {
                    sinceTick: wandering.sinceTick,
                    expiresTick: wandering.sinceTick + WANDERING_MONTH_LIMIT * TICKS_PER_MONTH,
                  }
                : null,
            }
          : {}),
        ...(units === undefined ? {} : { campaignEnabled: true as const }),
        ...(world.ruleFeatures.includes('five-stats') ? { fiveStats: true as const } : {}),
        ...nationInfo(
          nation,
          { cityCount: cities.filter((city) => city.kind !== 'PASS').length, generalCount: generals.length },
          viewer,
        ),
        cities: cities.map(mapCity),
        generals: generals.map((general) => garrisonGeneralInfo(general, viewer, units)),
      };
    }),
  ),
});
