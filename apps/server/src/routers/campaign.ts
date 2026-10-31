import { z } from 'zod';
import { campaignRelationshipInputSchema, campaignUnitInputSchema, campaignOrderInputSchema } from '@opensamguk/rules';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { worldInput } from '../game/queries';
import { readCampaignBoard, readCampaignRequest, submitCampaignRequest } from '../game/campaignApi';
import { readCampaignOrders, submitCampaignOrder } from '../game/campaignOrders';

const request = worldInput.extend({ requestId: z.uuid() });
export const campaignRouter = router({
  get: protectedProcedure.input(worldInput).query(({ ctx, input }) => readCampaignBoard(ctx, input.worldId)),
  orders: protectedProcedure.input(worldInput).query(({ ctx, input }) => readCampaignOrders(ctx, input.worldId)),
  order: worldVerifiedProcedure
    .input(request.extend({ payload: campaignOrderInputSchema, expectedUserId: z.uuid() }).strict())
    .mutation(({ ctx, input }) => submitCampaignOrder(ctx, input)),
  relationship: worldVerifiedProcedure
    .input(request.extend({ payload: campaignRelationshipInputSchema, expectedUserId: z.uuid().optional() }))
    .mutation(({ ctx, input }) => submitCampaignRequest(ctx, { ...input, kind: 'campaign.relationship' })),
  unit: worldVerifiedProcedure
    .input(request.extend({ payload: campaignUnitInputSchema }))
    .mutation(({ ctx, input }) => submitCampaignRequest(ctx, { ...input, kind: 'campaign.unit' })),
  request: protectedProcedure
    .input(request)
    .query(({ ctx, input }) => readCampaignRequest(ctx, input.worldId, input.requestId)),
});
