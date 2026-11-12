import { adviseGeneral, noticeDirectiveSchema, nowTick, unitSetSchema } from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { worldInput, worldClock } from '../queries';
import { activeSanctionWhere } from '../auth/sanction';
import { databaseTime, messagingActor } from '../messaging';
import { requireWorld, readView } from '../game/queries';
import { worldResolver } from '../game/resolver';
import { adviceOperationTurns } from '../game/operation';

export const adviceRouter = router({
  get: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        const world = await requireWorld(tx, input.worldId);
        const general = await messagingActor(tx, ctx, input.worldId);
        const at = await databaseTime(tx);
        if (
          await tx.sanction.findFirst({
            where: {
              userId: ctx.user.id,
              ...activeSanctionWhere(at.getTime()),
              AND: [{ OR: [{ worldId: null }, { worldId: input.worldId }] }],
            },
            select: { id: true },
          })
        )
          throw new TRPCError({ code: 'FORBIDDEN', message: '이 월드의 이용이 제한됐습니다.' });
        const tick = nowTick(worldClock(world), ctx.now),
          view = await readView(tx, input.worldId);
        const nation =
          general.nationId === null
            ? null
            : await tx.nation.findUniqueOrThrow({
                where: { worldId_id: { worldId: input.worldId, id: general.nationId } },
                select: { notice: true, noticeDirective: true },
              });
        const directive = nation?.noticeDirective == null ? null : noticeDirectiveSchema.parse(nation.noticeDirective);
        const { preset, resolver } = worldResolver(world);
        const result = adviseGeneral(view, general.id, {
          tick: general.nextTurnTick,
          unitSet: unitSetSchema.parse(world.unitSet),
          resolver,
          operations: await adviceOperationTurns(tx, { ...world, tick }, general, view),
          ...(directive === null
            ? {}
            : {
                directive: {
                  ...directive,
                  reason:
                    [...(nation!.notice.split(/\r?\n/, 1)[0] ?? '')].slice(0, 40).join('') ||
                    '국가 공지의 지시를 따른다.',
                },
              }),
        });
        return {
          ...result,
          basis: { tick, revision: general.turnRevision, userId: ctx.user.id, actorId: general.id },
          expandedByDefault: preset?.features.advisor ?? false,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  ),
});
