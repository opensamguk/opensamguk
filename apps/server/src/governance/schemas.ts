import { z } from 'zod';
import { governanceInputSchema } from '@opensamguk/rules';

export const governanceWorldInput = z.strictObject({ worldId: z.string().min(1).max(64) });
export const governanceRequestInput = governanceWorldInput.extend({ requestId: z.uuid() });
export const governanceSubmitInput = governanceRequestInput.extend({
  expectedUserId: z.uuid(),
  payload: governanceInputSchema,
});
