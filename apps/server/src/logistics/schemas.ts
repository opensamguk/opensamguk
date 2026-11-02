import { z } from 'zod';
import { logisticsInputSchema } from '@opensamguk/rules';

export const logisticsWorldInput = z.strictObject({ worldId: z.string().min(1).max(64) });
export const logisticsRequestInput = logisticsWorldInput.extend({ requestId: z.uuid() });
export const logisticsBoardInput = logisticsWorldInput.extend({ cityKey: z.number().int().min(1).max(2_147_483_647) });
export const logisticsSubmitInput = logisticsRequestInput.extend({
  expectedUserId: z.uuid(),
  payload: logisticsInputSchema,
});
export type LogisticsSubmitInput = z.infer<typeof logisticsSubmitInput>;
