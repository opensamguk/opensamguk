import { commands, unitSetSchema } from '@opensamguk/rules';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { readView, requireWorld, worldInput } from '../game/queries';
import { worldResolver } from '../game/resolver';
import { commandAvailability } from '../game/commandAvailability';
import { viewerGeneral } from '../queries';
export const commandList = commands
  .filter((def) => def.target === 'general')
  .map((def) => ({
    key: def.key,
    name: def.name,
    category: def.category,
    argsSchema: z.toJSONSchema(def.args, { io: 'input' }),
  }));
export const commandsRouter = router({
  list: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        const world = await requireWorld(tx, input.worldId);
        const ended = world.status === 'ENDED';
        const general = ended ? null : await viewerGeneral(tx, input.worldId, ctx.user.id);
        const actor =
          general?.removedAt === null
            ? {
                generalId: general.id,
                tick: general.nextTurnTick,
                unitSet: unitSetSchema.safeParse(world.unitSet).data,
              }
            : null;
        const view = actor ? await readView(tx, input.worldId) : null;
        return worldResolver(world)
          .resolver.list('general')
          .map((def) => ({
            key: def.key,
            name: def.name,
            category: def.category,
            argsSchema: z.toJSONSchema(def.args, { io: 'input' }),
            ...commandAvailability(def, view, actor, ended),
          }));
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  ),
});
