import { z } from 'zod';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { worldInput } from '../game/queries';
import { readPersonnelBoard } from '../game/personnelQueries';
import { readPersonnelRecent, readPersonnelRequest } from '../game/personnelRequests';
import { submitAndWaitPersonnel, withPersonnel } from '../game/personnelApi';

const requestInput = worldInput.extend({ requestId: z.uuid() });
const generalId = z.number().int().positive().max(2_147_483_647);
export const personnelRouter = router({
  officers: protectedProcedure
    .input(worldInput)
    .query(({ ctx, input }) =>
      withPersonnel(ctx, input.worldId, (tx) =>
        readPersonnelBoard(tx, { worldId: input.worldId, userId: ctx.user.id }),
      ),
    ),
  appoint: worldVerifiedProcedure
    .input(requestInput.extend({ generalId, officerLevel: z.number().int().min(5).max(11) }))
    .mutation(({ ctx, input }) =>
      submitAndWaitPersonnel(ctx, {
        worldId: input.worldId,
        requestId: input.requestId,
        kind: 'personnel.appoint',
        payload: { generalId: input.generalId, officerLevel: input.officerLevel },
      }),
    ),
  dismiss: worldVerifiedProcedure.input(requestInput.extend({ generalId })).mutation(({ ctx, input }) =>
    submitAndWaitPersonnel(ctx, {
      worldId: input.worldId,
      requestId: input.requestId,
      kind: 'personnel.dismiss',
      payload: { generalId: input.generalId },
    }),
  ),
  request: protectedProcedure
    .input(requestInput)
    .query(({ ctx, input }) =>
      withPersonnel(ctx, input.worldId, (tx, ready) =>
        readPersonnelRequest(tx, ready, { ...input, userId: ctx.user.id }),
      ),
    ),
  recent: protectedProcedure
    .input(worldInput)
    .query(({ ctx, input }) =>
      withPersonnel(ctx, input.worldId, (tx, ready) =>
        readPersonnelRecent(tx, ready, { worldId: input.worldId, userId: ctx.user.id, now: ctx.now }),
      ),
    ),
});
