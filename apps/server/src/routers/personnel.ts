import { isLocalOffice, nowTick } from '@opensamguk/rules';
import { z } from 'zod';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { worldInput } from '../game/queries';
import { readPersonnelBoard } from '../game/personnelQueries';
import { readPersonnelRecent, readPersonnelRequest } from '../game/personnelRequests';
import { submitAndWaitPersonnel, withPersonnel } from '../game/personnelApi';
import { worldClock } from '../queries';

const requestInput = worldInput.extend({ requestId: z.uuid() });
const generalId = z.number().int().positive().max(2_147_483_647);
export const personnelRouter = router({
  officers: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    withPersonnel(ctx, input.worldId, async (tx, ready, world) => ({
      ...(await readPersonnelBoard(
        tx,
        { worldId: input.worldId, userId: ctx.user.id, tick: nowTick(worldClock(world), ctx.now) },
        ready.officeEffectsEnabled === true,
        ready.courtRankEnabled === true,
        ready.localOfficeMinimum,
      )),
      ...(ready.secretaryEnabled ? { secretaryEnabled: true as const } : {}),
    })),
  ),
  appoint: worldVerifiedProcedure
    .input(
      requestInput
        .extend({
          generalId,
          officerLevel: z.number().int().min(2).max(11),
          cityKey: generalId.optional(),
          expectedHolderId: generalId.nullable().optional(),
        })
        .refine((input) =>
          isLocalOffice(input.officerLevel)
            ? input.cityKey !== undefined
            : input.cityKey === undefined && input.expectedHolderId === undefined,
        ),
    )
    .mutation(({ ctx, input }) =>
      submitAndWaitPersonnel(ctx, {
        worldId: input.worldId,
        requestId: input.requestId,
        kind: 'personnel.appoint',
        payload: {
          generalId: input.generalId,
          officerLevel: input.officerLevel,
          ...(input.cityKey === undefined ? {} : { cityKey: input.cityKey }),
          ...(input.expectedHolderId === undefined ? {} : { expectedHolderId: input.expectedHolderId }),
        },
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
