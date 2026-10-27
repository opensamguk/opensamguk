import { z } from 'zod';
import { campaignRelationshipInputSchema, campaignUnitInputSchema } from '@opensamguk/rules';
import { protectedProcedure, router } from '../trpc';
import { worldInput } from '../game/queries';
import { readCampaignBoard, readCampaignRequest, submitCampaignRequest } from '../game/campaignApi';

const request = worldInput.extend({ requestId: z.uuid() });
export const campaignRouter = router({
  get: protectedProcedure.input(worldInput).query(({ ctx, input }) => readCampaignBoard(ctx, input.worldId)),
  relationship: protectedProcedure
    .input(request.extend({ payload: campaignRelationshipInputSchema }))
    .mutation(({ ctx, input }) => submitCampaignRequest(ctx, { ...input, kind: 'campaign.relationship' })),
  unit: protectedProcedure
    .input(request.extend({ payload: campaignUnitInputSchema }))
    .mutation(({ ctx, input }) => submitCampaignRequest(ctx, { ...input, kind: 'campaign.unit' })),
  request: protectedProcedure
    .input(request)
    .query(({ ctx, input }) => readCampaignRequest(ctx, input.worldId, input.requestId)),
});
