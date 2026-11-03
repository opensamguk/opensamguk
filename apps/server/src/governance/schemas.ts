import { z } from 'zod';
import { governanceInputSchema } from '@opensamguk/rules';

export const governanceWorldInput = z.strictObject({ worldId: z.string().min(1).max(64) });
export const governanceRequestInput = governanceWorldInput.extend({ requestId: z.uuid() });
export const governanceSubmitInput = governanceRequestInput.extend({
  expectedUserId: z.uuid(),
  expectedGeneralId: z.number().int().min(1).max(2_147_483_647).optional(),
  payload: governanceInputSchema,
});
