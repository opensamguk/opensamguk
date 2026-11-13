import { TRPCError } from '@trpc/server';
import {
  INTEL_FEATURE,
  NATION_STRATEGY_FEATURE,
  OFFICE_EFFECTS_FEATURE,
  STRATEGY_KEYS,
  TICKS_PER_MONTH,
  WANDERING_MONTH_LIMIT,
  nowTick,
  readStoredNationStrategy,
  strategyMonth,
  toGameDate,
} from '@opensamguk/rules';
import { protectedProcedure, router } from '../trpc';
import { entityKey, readWorld, viewerGeneral, worldClock, worldInput } from '../queries';
import { cityCapacity, cityInfo, garrisonGeneralInfo, mapCity, nationInfo, visibility } from '../visibility';
import { readView, requireWorld } from '../game/queries';
import { nationPopulation, projectNationFinance, salaryRate } from '../game/nationFinance';
import { worldResolver } from '../game/resolver';

export const nationRouter = router({
  get: protectedProcedure.input(worldInput.extend({ nationId: entityKey }).strict()).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const viewer = await viewerGeneral(tx, input.worldId, ctx.user.id);
      const nation = await tx.nation.findUnique({
        where: { worldId_id: { worldId: input.worldId, id: input.nationId } },
      });
      if (!nation) throw new TRPCError({ code: 'NOT_FOUND', message: '국가를 찾을 수 없습니다.' });
      const openRoster = !world.ruleFeatures.includes(INTEL_FEATURE);
      const ownNation = visibility(viewer).nation(nation);
      const cities = await tx.city.findMany({
        where: input,
        orderBy: ownNation ? [{ region: 'asc' }, { level: 'desc' }, { cityKey: 'asc' }] : { cityKey: 'asc' },
      });
      const generals = await tx.general.findMany({ where: input, orderBy: { id: 'asc' } });
      const needsOfficeEffects =
        ownNation && world.status !== 'ENDED' && world.ruleFeatures.includes(OFFICE_EFFECTS_FEATURE);
      const state =
        needsOfficeEffects ||
        world.ruleFeatures.some((feature) => ['campaign-v1', 'nation-lifecycle-v1'].includes(feature))
          ? await readView(tx, input.worldId)
          : undefined;
      const units = state?.campaign?.units;
      const lifecycle = state?.nationLifecycle;
      const wandering = lifecycle?.nations[String(nation.id)];
      const settlements = cities.filter((city) => city.kind !== 'PASS').sort((a, b) => a.cityKey - b.cityKey);
      const finance =
        ownNation && world.status !== 'ENDED'
          ? projectNationFinance(world, ctx.now, settlements, generals, state)
          : undefined;
      const strategyStatus =
        ownNation && world.status !== 'ENDED' && world.ruleFeatures.includes(NATION_STRATEGY_FEATURE)
          ? await readStrategyStatus()
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
        ...nationPopulation(settlements),
        ...(ownNation ? { salaryRate } : {}),
        ...(finance ? { financeEstimate: finance.financeEstimate } : {}),
        ...(strategyStatus ? { strategyStatus } : {}),
        cities: cities.map((city) => {
          if (!ownNation) return { ...mapCity(city), ...cityCapacity(city) };
          const incomeEstimate = finance?.cityIncome.get(city.cityKey);
          return { ...cityInfo(city, viewer), ...(incomeEstimate ? { incomeEstimate } : {}) };
        }),
        generals: generals.map((general) =>
          garrisonGeneralInfo(general, viewer, units, { stats: openRoster, biography: openRoster }),
        ),
      };

      async function readStrategyStatus() {
        const storedWorld = await requireWorld(tx, input.worldId);
        const ledger = readStoredNationStrategy(storedWorld)?.nations[input.nationId];
        const current = strategyMonth(nowTick(worldClock(world), ctx.now));
        const globalUntil = ledger?.strategicUntil ?? 0;
        const availability = (until: number) => ({
          remainingMonths: Math.max(0, until - current),
          availableAt: until > current ? toGameDate(world.startYear, until * TICKS_PER_MONTH) : null,
        });
        const definitions = worldResolver(storedWorld).resolver.list('nation');
        return {
          ...availability(globalUntil),
          commands: STRATEGY_KEYS.flatMap((key) => {
            const definition = definitions.find((item) => item.key === key);
            return definition
              ? [{ key, name: definition.name, ...availability(Math.max(globalUntil, ledger?.commands[key] ?? 0)) }]
              : [];
          }),
        };
      }
    }),
  ),
});
