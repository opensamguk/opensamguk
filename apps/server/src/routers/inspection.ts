import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { worldInput } from '../queries';
import { inspectMemberRecords, inspectMembers } from '../game/operation';

export const inspectionRouter = router({
  members: protectedProcedure.input(worldInput).query(({ ctx, input }) => inspectMembers(ctx, input.worldId)),
  memberRecords: protectedProcedure
    .input(worldInput.extend({ generalId: z.number().int().positive() }))
    .query(({ ctx, input }) => inspectMemberRecords(ctx, input.worldId, input.generalId)),
});
