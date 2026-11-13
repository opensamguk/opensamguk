import { commands } from '@opensamguk/rules';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { readView, requireGeneral, requireWorld, worldInput } from '../game/queries';
import { worldResolver } from '../game/resolver';
import { worldInput as strictWorldInput } from '../queries';
export const commandList = commands
  .filter((def) => def.target === 'general')
  .map((def) => ({
    key: def.key,
    name: def.name,
    category: def.category,
    argsSchema: z.toJSONSchema(def.args, { io: 'input' }),
  }));
export const commandsRouter = router({
  recruitCandidates: protectedProcedure.input(strictWorldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        const world = await requireWorld(tx, input.worldId);
        const actor = await requireGeneral(tx, world.id, ctx.user.id);
        const invite = worldResolver(world).resolver.get('invite');
        if (!invite || world.status === 'ENDED') return [];
        const view = await readView(tx, world.id);
        const commandActor = { generalId: actor.id, tick: actor.nextTurnTick };
        return Object.values(view.generals)
          .filter(
            ({ id, nationId }) => nationId === null && invite.precheck(view, commandActor, { generalId: id }) === null,
          )
          .sort((a, b) => a.id - b.id)
          .map(({ id, name, portraitId, userId, cityKey }) => ({
            id,
            name,
            portraitId,
            isHuman: userId !== null,
            cityKey,
            cityName: view.cities[cityKey]?.name ?? null,
          }));
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  ),
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
