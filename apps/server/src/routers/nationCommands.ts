import {
  canExecuteNationCommand,
  canExecuteCityNationCommand,
  canUseNationTurns,
  unitSetSchema,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { requireGeneral, requireWorld, readView, worldInput } from '../game/queries';
import { worldResolver } from '../game/resolver';
import { withPersonnel } from '../game/personnelApi';
import { commandInput } from '../game/slots';

async function actorCommands(tx: Parameters<typeof requireWorld>[0], worldId: string, userId: string) {
  const world = await requireWorld(tx, worldId);
  const actor = await requireGeneral(tx, worldId, userId);
  if (actor.nationId === null || !canUseNationTurns(actor.officerLevel))
    throw new TRPCError({ code: 'FORBIDDEN', message: '국가 예턴 권한이 없습니다.' });
  const commands = worldResolver(world)
    .resolver.list('nation')
    .filter(
      (def) =>
        canExecuteNationCommand(actor.officerLevel, def.key) ||
        canExecuteCityNationCommand(world, actor.officerLevel, def.key),
    );
  return { world, actor, commands };
}
export const nationCommandsRouter = router({
  list: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    withPersonnel(ctx, input.worldId, async (tx) => {
      const { commands } = await actorCommands(tx, input.worldId, ctx.user.id);
      return commands.map((def) => ({
        key: def.key,
        name: def.name,
        argsSchema: z.toJSONSchema(def.args, { io: 'input' }),
      }));
    }),
  ),
  precheck: protectedProcedure.input(worldInput.extend(commandInput)).query(({ ctx, input }) =>
    withPersonnel(ctx, input.worldId, async (tx) => {
      const { world, actor, commands } = await actorCommands(tx, input.worldId, ctx.user.id);
      const def = commands.find((candidate) => candidate.key === input.commandKey);
      const args = def?.args.safeParse(input.args === undefined ? {} : input.args);
      if (!def || !args?.success) return { ok: false as const, reason: '명령과 인자를 확인하세요.' };
      const failure = def.precheck(
        await readView(tx, input.worldId),
        {
          generalId: actor.id,
          target: 'nation',
          authority: 'office',
          tick: actor.nextTurnTick,
          unitSet: unitSetSchema.parse(world.unitSet),
        },
        args.data,
      );
      return failure ? { ok: false as const, reason: failure.message } : { ok: true as const };
    }),
  ),
});
