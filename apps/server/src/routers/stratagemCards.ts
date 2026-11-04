import { TRPCError } from '@trpc/server';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { stratagemCardsService } from '../stratagemCards/bootstrap';
import { StratagemCardsServiceError } from '../stratagemCards/service';
import {
  stratagemCardsRequestInput,
  stratagemCardsSubmitInput,
  stratagemCardsWorldInput,
} from '../stratagemCards/schemas';

async function response<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof StratagemCardsServiceError) throw new TRPCError({ code: error.code, message: error.message });
    throw error;
  }
}
export const stratagemCardsRouter = router({
  mine: protectedProcedure
    .input(stratagemCardsWorldInput)
    .query(({ ctx, input }) => response(() => stratagemCardsService(ctx).mine(input))),
  setTrap: worldVerifiedProcedure
    .input(stratagemCardsSubmitInput)
    .mutation(({ ctx, input }) => response(() => stratagemCardsService(ctx).setTrap(input))),
  request: protectedProcedure
    .input(stratagemCardsRequestInput)
    .query(({ ctx, input }) => response(() => stratagemCardsService(ctx).request(input))),
});
