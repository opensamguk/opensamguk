import { checkReplayOrigin, historicEventsView, readHistoricEventsStorage } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { requireWorld, worldInput } from '../game/queries';
import { requirePersonnelSession } from '../game/personnelAdmission';
import { personnelIdentity } from '../game/personnelApi';
import { router, worldVerifiedProcedure } from '../trpc';

export const historicEventsRouter = router({
  list: worldVerifiedProcedure.input(worldInput).query(({ ctx, input }) => {
    const started = performance.now();
    return ctx.db.$transaction(
      async (tx) => {
        await requirePersonnelSession(tx, personnelIdentity(ctx, started));
        const world = await requireWorld(tx, input.worldId);
        const historicEvents = readHistoricEventsStorage(world, checkReplayOrigin, hashState);
        if (!historicEvents) return historicEventsView(undefined, null);
        const general = await tx.general.findUnique({
          where: { worldId_userId: { worldId: world.id, userId: ctx.user.id } },
          select: { nationId: true, removedAt: true },
        });
        return historicEventsView(historicEvents, general?.removedAt === null ? general.nationId : null);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }),
});
