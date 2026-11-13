import {
  canExecuteNationCommand,
  canExecuteCityNationCommand,
  canExecuteResearchNationCommand,
  canUseNationTurns,
  STRATEGY_KEYS,
  strategyMonth,
  TICKS_PER_MONTH,
  toGameDate,
  unitSetSchema,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { requireGeneral, requireWorld, readView, worldInput } from '../game/queries';
import { worldResolver } from '../game/resolver';
import { withPersonnel } from '../game/personnelApi';
import { commandInput } from '../game/slots';
import { commandAvailability } from '../game/commandAvailability';

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
        canExecuteCityNationCommand(world, actor.officerLevel, def.key) ||
        canExecuteResearchNationCommand(world, actor.officerLevel, def.key),
    );
  return { world, actor, commands };
}
export const nationCommandsRouter = router({
  list: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    withPersonnel(ctx, input.worldId, async (tx) => {
      const { world, actor, commands } = await actorCommands(tx, input.worldId, ctx.user.id);
      const ended = world.status === 'ENDED';
      const view = ended ? null : await readView(tx, input.worldId);
      const commandActor = {
        generalId: actor.id,
        target: 'nation' as const,
        authority: 'office' as const,
        tick: actor.nextTurnTick,
        unitSet: unitSetSchema.safeParse(world.unitSet).data,
      };
      const cooldown = view?.nationStrategy?.nations[actor.nationId!];
      const current = strategyMonth(commandActor.tick);
      return commands.map((def) => {
        const key = STRATEGY_KEYS.find((key) => key === def.key);
        const availableMonth = key ? Math.max(cooldown?.strategicUntil ?? 0, cooldown?.commands[key] ?? 0) : 0;
        return {
          key: def.key,
          name: def.name,
          category: def.category,
          ...(key
            ? {
                cooldown: {
                  remainingMonths: Math.max(0, availableMonth - current),
                  availableAt:
                    availableMonth > current ? toGameDate(world.startYear, availableMonth * TICKS_PER_MONTH) : null,
                },
              }
            : {}),
          argsSchema: z.toJSONSchema(def.args, { io: 'input' }),
          ...commandAvailability(def, view, commandActor, ended),
        };
      });
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
