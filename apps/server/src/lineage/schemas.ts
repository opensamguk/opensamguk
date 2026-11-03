import { z } from 'zod';
import { lineageInputSchema, lineageId } from '@opensamguk/rules';
export const lineageWorldInput = z.strictObject({ worldId: z.string().min(1).max(64) });
export const lineageGetInput = lineageWorldInput.extend({ generalId: lineageId.optional() });
export const lineageRequestInput = lineageWorldInput.extend({ requestId: z.uuid() });
export const lineageSubmitInput = lineageRequestInput.extend({
  expectedUserId: z.uuid(),
  expectedGeneralId: lineageId,
  payload: lineageInputSchema,
});
