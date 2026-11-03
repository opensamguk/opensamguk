import { TRPCError } from '@trpc/server';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { lineageService } from '../lineage/bootstrap';
import { LineageServiceError } from '../lineage/service';
import { lineageRequestInput, lineageSubmitInput, lineageGetInput } from '../lineage/schemas';

async function response<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof LineageServiceError) throw new TRPCError({ code: error.code, message: error.message });
    throw error;
  }
}
export const lineageRouter = router({
  get: protectedProcedure
    .input(lineageGetInput)
    .query(({ ctx, input }) => response(() => lineageService(ctx).get(input))),
  submit: worldVerifiedProcedure
    .input(lineageSubmitInput)
    .mutation(({ ctx, input }) => response(() => lineageService(ctx).submit(input))),
  request: protectedProcedure
    .input(lineageRequestInput)
    .query(({ ctx, input }) => response(() => lineageService(ctx).request(input))),
});
