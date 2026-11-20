import { readTransactionOptions } from '../readTransaction';
import {
  commandMoveTargets,
  commandAttackTargets,
  commandPlayerDocs,
  commands,
  unitSetSchema,
  type CommandDef,
} from '@opensamguk/rules';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { readView, requireGeneral, requireWorld, worldInput } from '../game/queries';
import { worldResolver } from '../game/resolver';
import { commandAvailability } from '../game/commandAvailability';
import { viewerGeneral, worldInput as strictWorldInput } from '../queries';
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
  moveTargets: protectedProcedure.input(strictWorldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        const world = await requireWorld(tx, input.worldId);
        const general = await requireGeneral(tx, world.id, ctx.user.id);
        if (world.status === 'ENDED' || general.removedAt !== null) return [];
        return commandMoveTargets(await readView(tx, world.id), general.id, general.nextTurnTick);
      },
      { ...readTransactionOptions },
    ),
  ),
  attackTargets: protectedProcedure.input(strictWorldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        const world = await requireWorld(tx, input.worldId);
        const general = await requireGeneral(tx, world.id, ctx.user.id);
        if (world.status === 'ENDED' || general.removedAt !== null) return [];
        return commandAttackTargets(await readView(tx, world.id), general.id);
      },
      { ...readTransactionOptions },
    ),
  ),
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
      { ...readTransactionOptions },
    ),
  ),
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
            ...describeCommand(def),
            ...commandAvailability(def, view, actor, ended),
          }));
      },
      { ...readTransactionOptions },
    ),
  ),
});
