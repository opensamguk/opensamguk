import { protectedProcedure, router } from '../trpc';
import { nextTurnAt, turnSchedule, readWorld, requireGeneral, worldClock, worldInput } from '../queries';
import { cityInfo, ownGeneralInfo, logInfo, logSelect, nationInfo } from '../visibility';
import { nowTick, policyOptions } from '@opensamguk/rules';
import { displaySlots, readSlots } from '../game/slots';
import { readCityScaleProjection } from '../game/cityScale';
import { readView } from '../game/queries';
import { cityDefense } from '../game/defenseRead';

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
                _count: { select: { cities: { where: { OR: [{ kind: null }, { kind: 'CITY' }] } }, generals: true } },
              },
            });
      const turns = displaySlots(await readSlots(tx, input.worldId, general.id));
      const defense = cityDefense(
        city,
        general.removedAt === null ? [general] : [],
        world.startYear,
        nowTick(worldClock(world), ctx.now),
        world.ruleFeatures.includes('campaign-v1') ? await readView(tx, world.id) : undefined,
      );
      const defendingTroops =
        general.removedAt === null
          ? (defense.generals.find(({ generalId }) => generalId === general.id)?.troops ?? 0)
          : 0;
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
          defense: {
            participating: defendingTroops > 0,
            troops: defendingTroops,
            minimumTraining: defense.minimumTraining,
            minimumMorale: defense.minimumMorale,
          },
          policy: (() => {
            const option = policyOptions().find((entry) => entry.key === (general.defaultPolicy ?? 'none'))!;
            return { key: option.key, name: option.name };
          })(),
        },
        city: { ...cityInfo(city, general), ...(ruins ? { ruin: ruins.get(city.cityKey) ?? null } : {}) },
        nation:
          nation === null
            ? null
            : nationInfo(
                nation,
                {
                  cityCount: nation._count.cities,
                  generalCount: nation._count.generals,
                },
                general,
              ),
        nextTurnAt: nextTurnAt(world, general.nextTurnTick),
        turnSchedule: turnSchedule(world, general.nextTurnTick),
        turnsPreview: Array.from({ length: 5 }, (_, slot) => ({ slot, ...turns[slot]! })),
        recentLogs: logs.map(logInfo),
      };
    }),
  ),
});
