import { protectedProcedure, router } from '../trpc';
import { worldInput } from '../queries';
import { inspectMembers } from '../game/operation';

export const inspectionRouter = router({
  members: protectedProcedure.input(worldInput).query(({ ctx, input }) => inspectMembers(ctx, input.worldId)),
});
