import { z } from 'zod';
import { cityResourceInputSchema } from '@opensamguk/rules';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { worldInput } from '../game/queries';
import { readCityResourceBoard, readCityResourceRequest, submitCityResourceRequest } from '../game/cityResourcesApi';

const request = worldInput.extend({ requestId: z.uuid() });
export const cityResourcesRouter = router({
  get: protectedProcedure
    .input(worldInput.extend({ cityKey: z.number().int().min(1).max(2_147_483_647) }))
    .query(({ ctx, input }) => readCityResourceBoard(ctx, input.worldId, input.cityKey)),
  allocate: worldVerifiedProcedure
    .input(request.extend({ expectedUserId: z.uuid(), payload: cityResourceInputSchema }))
    .mutation(({ ctx, input }) => submitCityResourceRequest(ctx, input)),
  request: protectedProcedure
    .input(request)
    .query(({ ctx, input }) => readCityResourceRequest(ctx, input.worldId, input.requestId)),
});
