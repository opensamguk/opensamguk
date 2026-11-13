import { hashState } from '@opensamguk/shared/node';
import { z } from 'zod';
import { parseResourceKey, statRulesSchema, unitSetSchema } from '@opensamguk/rules';
import { readWorld, viewerGeneral, worldInput } from '../queries';
import { protectedProcedure, router } from '../trpc';
import { readView } from '../game/queries';
import { recruitmentAvailability } from '../game/recruitment';

const unitDescriptions = z.object({
  crewTypes: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      info: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
    }),
  ),
});

export const resourcesRouter = router({
  worldRules: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const stored = await tx.world.findUniqueOrThrow({
        where: { id: input.worldId },
        select: { unitSetKey: true, unitSet: true, statRules: true },
      });
      const unitSet = unitSetSchema.parse(stored.unitSet);
      const { name, version } = parseResourceKey(stored.unitSetKey);
      const source = await tx.gameResource.findFirst({
        where: { kind: 'UNIT_SET', name, version, status: 'PUBLISHED' },
        select: { content: true, contentHash: true },
      });
      const description =
        source &&
        hashState(source.content) === source.contentHash &&
        hashState(unitSetSchema.safeParse(source.content).data ?? null) === hashState(unitSet)
          ? unitDescriptions.safeParse(source.content).data
          : undefined;
      const descriptions = new Map(description?.crewTypes.map((row) => [row.id, row.info]));
      const actor = unitSet.crewTypes.some((unit) => unit.requirements?.length)
        ? await viewerGeneral(tx, input.worldId, ctx.user.id)
        : null;
      return {
        unitSetKey: stored.unitSetKey,
        ...(world.ruleFeatures.includes('battle-affinity-v2') ? { battleAffinity: 'multiply' as const } : {}),
        unitSet: {
          ...unitSet,
          crewTypes: unitSet.crewTypes.map((unit) => {
            const info = descriptions.get(unit.id);
            return info?.length ? { ...unit, info } : unit;
          }),
        },
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
