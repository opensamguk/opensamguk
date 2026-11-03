import { statRulesSchema, unitSetSchema } from '@opensamguk/rules';
import { readWorld, worldInput } from '../queries';
import { protectedProcedure, router } from '../trpc';

export const resourcesRouter = router({
  worldRules: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const stored = await tx.world.findUniqueOrThrow({
        where: { id: input.worldId },
        select: { unitSetKey: true, unitSet: true, statRules: true },
      });
      return {
        unitSetKey: stored.unitSetKey,
        unitSet: unitSetSchema.parse(stored.unitSet),
        statRules: {
          ...statRulesSchema.parse({ stat: stored.statRules }).stat,
          count: world.ruleFeatures.includes('five-stats') ? (5 as const) : (3 as const),
        },
      };
    }),
  ),
});
