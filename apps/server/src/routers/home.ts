import { protectedProcedure, router } from '../trpc';
import { nextTurnAt, turnSchedule, readWorld, requireGeneral, worldInput } from '../queries';
import { cityInfo, ownGeneralInfo, logInfo, logSelect, nationInfo } from '../visibility';
import { OFFICE_EFFECTS_FEATURE, policyOptions } from '@opensamguk/rules';
import { displaySlots, readSlots } from '../game/slots';
import { readCityScaleProjection } from '../game/cityScale';
import { nationPopulation, projectNationFinance, salaryRate } from '../game/nationFinance';
import { readView } from '../game/queries';

export const homeRouter = router({
  get: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      const city = await tx.city.findUniqueOrThrow({
        where: { worldId_cityKey: { worldId: input.worldId, cityKey: general.cityKey } },
      });
      const nation =
        general.nationId === null
          ? null
          : await tx.nation.findUniqueOrThrow({
              where: { worldId_id: { worldId: input.worldId, id: general.nationId } },
              include: {
                cities: {
                  where: { OR: [{ kind: null }, { kind: 'CITY' }] },
                  orderBy: { cityKey: 'asc' },
                  select: { cityKey: true, commerce: true, agriculture: true, population: true, populationMax: true },
                },
                generals: { select: { activeFromYear: true, removedAt: true } },
              },
            });
      const state =
        nation && world.status !== 'ENDED' && world.ruleFeatures.includes(OFFICE_EFFECTS_FEATURE)
          ? await readView(tx, input.worldId)
          : undefined;
      const finance =
        nation && world.status !== 'ENDED'
          ? projectNationFinance(world, ctx.now, nation.cities, nation.generals, state)
          : undefined;
      const turns = displaySlots(await readSlots(tx, input.worldId, general.id));
      const ruins = await readCityScaleProjection(tx, input.worldId, world.ruleFeatures);
      const logs = await tx.generalLog.findMany({
        where: { worldId: input.worldId, generalId: general.id },
        orderBy: [{ tick: 'desc' }, { id: 'desc' }],
        take: 10,
        select: logSelect,
      });
      return {
        general: {
          ...ownGeneralInfo(general),
          ...(finance
            ? {
                salaryEstimate: {
                  gold:
                    general.activeFromYear <= finance.financeEstimate.gold.year
                      ? finance.financeEstimate.gold.perGeneral
                      : 0,
                  rice:
                    general.activeFromYear <= finance.financeEstimate.rice.year
                      ? finance.financeEstimate.rice.perGeneral
                      : 0,
                },
              }
            : {}),
          policy: (() => {
            const option = policyOptions().find((entry) => entry.key === (general.defaultPolicy ?? 'none'))!;
            return { key: option.key, name: option.name };
          })(),
        },
        city: { ...cityInfo(city, general), ...(ruins ? { ruin: ruins.get(city.cityKey) ?? null } : {}) },
        nation:
          nation === null
            ? null
            : {
                ...nationInfo(
                  nation,
                  { cityCount: nation.cities.length, generalCount: nation.generals.length },
                  general,
                ),
                ...nationPopulation(nation.cities),
                salaryRate,
                ...(finance ? { financeEstimate: finance.financeEstimate } : {}),
              },
        nextTurnAt: nextTurnAt(world, general.nextTurnTick),
        turnSchedule: turnSchedule(world, general.nextTurnTick),
        turnsPreview: Array.from({ length: 5 }, (_, slot) => ({ slot, ...turns[slot]! })),
        recentLogs: logs.map(logInfo),
      };
    }),
  ),
});
