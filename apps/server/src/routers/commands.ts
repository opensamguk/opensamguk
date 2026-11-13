import { commandPlayerDocs, commands, type CommandDef } from '@opensamguk/rules';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { requireWorld, worldInput } from '../game/queries';
import { worldResolver } from '../game/resolver';
function describeCommand(def: CommandDef) {
  const doc = commandPlayerDocs[def.key];
  if (!doc) throw new Error(`명령 도움말이 없습니다: ${def.key}`);
  return {
    key: def.key,
    name: def.name,
    category: def.category,
    argsSchema: z.toJSONSchema(def.args, { io: 'input' }),
    description: doc.summary,
    cost: doc.cost,
    requirements: doc.requires,
    turns: 1,
  };
}

export const commandList = commands.filter((def) => def.target === 'general').map(describeCommand);
export const commandsRouter = router({
  list: protectedProcedure.input(worldInput).query(async ({ ctx, input }) => {
    const world = await requireWorld(ctx.db, input.worldId);
    return worldResolver(world).resolver.list('general').map(describeCommand);
  }),
});
