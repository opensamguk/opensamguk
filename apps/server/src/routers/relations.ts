import { readStoredRelations, toGameDate } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { requireWorld } from '../game/queries';
import { worldInput } from '../queries';
import { router, worldVerifiedProcedure } from '../trpc';

export const relationsRouter = router({
  list: worldVerifiedProcedure.input(worldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        const world = await requireWorld(tx, input.worldId);
        const relations = readStoredRelations(world, hashState);
        if (!relations) return { enabled: false, items: [] };

        const { year } = toGameDate(world.startYear, world.monthlyTick);
        const end =
          world.status === 'ENDED'
            ? await tx.worldResult.findUniqueOrThrow({ where: { worldId: world.id }, select: { endedYear: true } })
            : null;
        const ids = [...new Set(relations.pairs.flatMap(({ a, b }) => [a.id, b.id]))];
        const generals = await tx.general.findMany({
          where: {
            worldId: world.id,
            id: { in: ids },
            activeFromYear: { lte: end ? Math.min(year, end.endedYear) : year },
            removedAt: null,
          },
          select: { id: true, name: true },
        });
        const visible = new Map(generals.map((general) => [general.id, general]));
        const items = relations.pairs.flatMap(({ a, b, kind }) => {
          const first = visible.get(a.id);
          const second = visible.get(b.id);
          return first && second ? [{ a: first, b: second, kind }] : [];
        });
        return { enabled: true, items };
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  ),
});
