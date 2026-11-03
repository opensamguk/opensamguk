import { TRPCError } from '@trpc/server';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { governanceService } from '../governance/bootstrap';
import { GovernanceServiceError } from '../governance/service';
import { governanceRequestInput, governanceSubmitInput, governanceWorldInput } from '../governance/schemas';

async function response<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof GovernanceServiceError) throw new TRPCError({ code: error.code, message: error.message });
    throw error;
  }
}
export const governanceRouter = router({
  get: protectedProcedure
    .input(governanceWorldInput)
    .query(({ ctx, input }) => response(() => governanceService(ctx).get(input))),
  submit: worldVerifiedProcedure
    .input(governanceSubmitInput)
    .mutation(({ ctx, input }) => response(() => governanceService(ctx).submit(input))),
  request: protectedProcedure
    .input(governanceRequestInput)
    .query(({ ctx, input }) => response(() => governanceService(ctx).request(input))),
});
