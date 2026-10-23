import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { entityKey, worldInput } from '../queries';
import { closeOperation, createOperation, getOperation, listOperations, suggestOperation } from '../game/operation';

const operationInput = worldInput.extend({ id: z.uuid() }).strict();
const minimum = z.number().int().min(0).max(2_147_483_647);
export const operationRouter = router({
  create: protectedProcedure
    .input(
      worldInput
        .extend({
          targetCityKey: entityKey,
          targetYear: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
          targetMonth: z.number().int().min(1).max(12),
          min: z.strictObject({ crew: minimum, train: minimum, atmos: minimum }),
          memberIds: z.array(entityKey),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) => createOperation(ctx, input)),
  list: protectedProcedure.input(worldInput).query(({ ctx, input }) => listOperations(ctx, input.worldId)),
  get: protectedProcedure.input(operationInput).query(({ ctx, input }) => getOperation(ctx, input)),
  suggest: protectedProcedure.input(operationInput).query(({ ctx, input }) => suggestOperation(ctx, input)),
  close: protectedProcedure.input(operationInput).mutation(({ ctx, input }) => closeOperation(ctx, input)),
});
