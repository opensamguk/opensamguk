import { TRPCError } from '@trpc/server';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { logisticsService } from '../logistics/bootstrap';
import { LogisticsServiceError } from '../logistics/service';
import { logisticsBoardInput, logisticsRequestInput, logisticsSubmitInput } from '../logistics/schemas';

async function response<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof LogisticsServiceError) throw new TRPCError({ code: error.code, message: error.message });
    throw error;
  }
}
export const logisticsRouter = router({
  get: protectedProcedure
    .input(logisticsBoardInput)
    .query(({ ctx, input }) => response(() => logisticsService(ctx).get(input))),
  submit: worldVerifiedProcedure
    .input(logisticsSubmitInput)
    .mutation(({ ctx, input }) => response(() => logisticsService(ctx).submit(input))),
  request: protectedProcedure
    .input(logisticsRequestInput)
    .query(({ ctx, input }) => response(() => logisticsService(ctx).request(input))),
});
