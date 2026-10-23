import { commands } from '@opensamguk/rules';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { requireWorld, worldInput } from '../game/queries';
import { worldResolver } from '../game/resolver';
export const commandList = commands
  .filter((def) => def.target === 'general')
  .map((def) => ({
    key: def.key,
    name: def.name,
    category: def.category,
    argsSchema: z.toJSONSchema(def.args, { io: 'input' }),
  }));
export const commandsRouter = router({
  list: protectedProcedure.input(worldInput).query(async ({ ctx, input }) => {
    const world = await requireWorld(ctx.db, input.worldId);
    return worldResolver(world)
      .resolver.list('general')
      .map((def) => ({
        key: def.key,
        name: def.name,
        category: def.category,
        argsSchema: z.toJSONSchema(def.args, { io: 'input' }),
      }));
  }),
});
