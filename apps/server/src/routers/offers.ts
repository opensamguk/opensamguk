import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { worldInput } from '../game/queries';
import { readMyAssignmentOffers } from '../game/assignmentOfferReads';
import { submitAndWaitPersonnel, withPersonnel } from '../game/personnelApi';

export const offersRouter = router({
  mine: protectedProcedure
    .input(worldInput)
    .query(({ ctx, input }) =>
      withPersonnel(ctx, input.worldId, (tx) => readMyAssignmentOffers(tx, input.worldId, ctx.user.id)),
    ),
  respond: protectedProcedure
    .input(worldInput.extend({ requestId: z.uuid(), offerId: z.string().min(1).max(128), accept: z.boolean() }))
    .mutation(({ ctx, input }) =>
      submitAndWaitPersonnel(ctx, {
        worldId: input.worldId,
        requestId: input.requestId,
        kind: 'offer.respond',
        payload: { offerId: input.offerId, accept: input.accept },
      }),
    ),
});
