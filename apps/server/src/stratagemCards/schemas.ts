import { z } from 'zod';
import { cardId, stratagemCardsInputSchema } from '@opensamguk/rules';
export const stratagemCardsWorldInput = z.strictObject({ worldId: z.string().min(1).max(64) });
export const stratagemCardsRequestInput = stratagemCardsWorldInput.extend({ requestId: z.uuid() });
export const stratagemCardsSubmitInput = stratagemCardsRequestInput.extend({
  expectedUserId: z.uuid(),
  expectedGeneralId: cardId,
  payload: stratagemCardsInputSchema,
});
