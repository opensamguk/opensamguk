import { statRulesSchema, unitSetSchema } from '@opensamguk/rules';
import { readWorld, viewerGeneral, worldInput } from '../queries';
import { protectedProcedure, router } from '../trpc';
import { readView } from '../game/queries';
import { recruitmentAvailability } from '../game/recruitment';

export const resourcesRouter = router({
  worldRules: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const stored = await tx.world.findUniqueOrThrow({
        where: { id: input.worldId },
        select: { unitSetKey: true, unitSet: true, statRules: true },
      });
      const unitSet = unitSetSchema.parse(stored.unitSet);
      const actor = unitSet.crewTypes.some((unit) => unit.requirements?.length)
        ? await viewerGeneral(tx, input.worldId, ctx.user.id)
        : null;
      return {
        unitSetKey: stored.unitSetKey,
        unitSet,
        ...(actor
          ? recruitmentAvailability(unitSet, await readView(tx, input.worldId), {
              generalId: actor.id,
              tick: world.clockTick,
            })
          : {}),
        statRules: {
          ...statRulesSchema.parse({ stat: stored.statRules }).stat,
          count: world.ruleFeatures.includes('five-stats') ? (5 as const) : (3 as const),
        },
      };
    }),
  ),
});
