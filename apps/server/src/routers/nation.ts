import { TRPCError } from '@trpc/server';
import { estimateTaxIncome, nowTick, TICKS_PER_MONTH, toGameDate, WANDERING_MONTH_LIMIT } from '@opensamguk/rules';
import { protectedProcedure, router } from '../trpc';
import { entityKey, readWorld, viewerGeneral, worldClock, worldInput } from '../queries';
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
      const ownNation = visibility(viewer).nation(nation);
      const cities = await tx.city.findMany({
        where: input,
        orderBy: ownNation ? [{ region: 'asc' }, { level: 'desc' }, { cityKey: 'asc' }] : { cityKey: 'asc' },
      });
      const generals = await tx.general.findMany({ where: input, orderBy: { id: 'asc' } });
      const state = world.ruleFeatures.some((feature) => ['campaign-v1', 'nation-lifecycle-v1'].includes(feature))
        ? await readView(tx, input.worldId)
        : undefined;
      const units = state?.campaign?.units;
      const lifecycle = state?.nationLifecycle;
      const wandering = lifecycle?.nations[String(nation.id)];
      const settlements = cities.filter((city) => city.kind !== 'PASS').sort((a, b) => a.cityKey - b.cityKey);
      const financeEstimate =
        ownNation && world.status !== 'ENDED'
          ? (() => {
              const current = toGameDate(world.startYear, nowTick(worldClock(world), ctx.now));
              const estimate = (resource: 'gold' | 'rice', months: readonly number[]) => {
                const month = months.find((value) => value >= current.month) ?? months[0]!;
                const year = current.year + (month < current.month ? 1 : 0);
                const members = generals.filter(
                  (general) => general.removedAt === null && general.activeFromYear <= year,
                );
                return { year, month, ...estimateTaxIncome(settlements, members.length, resource) };
              };
              return {
                gold: estimate('gold', [1, 7]),
                rice: estimate('rice', [4, 10]),
                destination: world.ruleFeatures.includes('city-resources-v1') ? ('city' as const) : ('nation' as const),
              };
            })()
          : undefined;
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
        ...nationInfo(nation, { cityCount: settlements.length, generalCount: generals.length }, viewer),
        philosophy: nation.philosophy,
        population: settlements.reduce((sum, city) => sum + city.population, 0),
        ...(financeEstimate ? { financeEstimate } : {}),
        cities: cities.map(mapCity),
        generals: generals.map((general) => garrisonGeneralInfo(general, viewer, units)),
      };
    }),
  ),
});
