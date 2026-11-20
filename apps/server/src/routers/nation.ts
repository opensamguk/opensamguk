import { TRPCError } from '@trpc/server';
import { TICKS_PER_MONTH, WANDERING_MONTH_LIMIT } from '@opensamguk/rules';
import { protectedProcedure, router } from '../trpc';
import { entityKey, readWorld, viewerGeneral, worldInput } from '../queries';
import { cityCapacity, cityInfo, garrisonGeneralInfo, mapCity, nationInfo, visibility } from '../visibility';
import { readView } from '../game/queries';
import { nationPopulation, projectNationFinance, salaryRate } from '../game/nationFinance';

export const nationRouter = router({
  get: protectedProcedure.input(worldInput.extend({ nationId: entityKey }).strict()).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const viewer = await viewerGeneral(tx, input.worldId, ctx.user.id);
      const nation = await tx.nation.findUnique({
        where: { worldId_id: { worldId: input.worldId, id: input.nationId } },
      });
      if (!nation) throw new TRPCError({ code: 'NOT_FOUND', message: '국가를 찾을 수 없습니다.' });
      const openRoster = !world.fogOfWar;
      const ownNation = visibility(viewer).nation(nation);
      const cities = await tx.city.findMany({
        where: input,
        orderBy: ownNation ? [{ region: 'asc' }, { level: 'desc' }, { cityKey: 'asc' }] : { cityKey: 'asc' },
      });
      const generals = await tx.general.findMany({ where: input, orderBy: { id: 'asc' } });
      const state = await readView(tx, input.worldId);
      const units = state?.campaign?.units;
      const lifecycle = state?.nationLifecycle;
      const wandering = lifecycle?.nations[String(nation.id)];
      const settlements = cities
        .filter((city) => city.kind !== 'PASS' && city.kind !== 'FIELD')
        .sort((a, b) => a.cityKey - b.cityKey);
      const finance =
        ownNation && world.status !== 'ENDED'
          ? projectNationFinance(world, ctx.now, settlements, generals, state)
          : undefined;
      return {
        ...(lifecycle
          ? {
              wandering: wandering
                ? {
                    sinceTick: wandering.sinceTick,
                    expiresTick: wandering.sinceTick + WANDERING_MONTH_LIMIT * TICKS_PER_MONTH,
                  }
                : null,
            }
          : {}),

        ...nationInfo(nation, { cityCount: settlements.length, generalCount: generals.length }, viewer),
        philosophy: nation.philosophy,
        ...nationPopulation(settlements),
        ...(ownNation ? { salaryRate } : {}),
        ...(finance ? { financeEstimate: finance.financeEstimate } : {}),
        cities: cities.map((city) => {
          if (!ownNation)
            return { ...mapCity(city, openRoster || visibility(viewer).city(city)), ...cityCapacity(city) };
          const incomeEstimate = finance?.cityIncome.get(city.cityKey);
          return { ...cityInfo(city, viewer), ...(incomeEstimate ? { incomeEstimate } : {}) };
        }),
        generals: generals.map((general) =>
          garrisonGeneralInfo(general, viewer, units, { stats: openRoster, biography: openRoster }),
        ),
      };
    }),
  ),
});
