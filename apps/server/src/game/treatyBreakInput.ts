import { z } from 'zod';
import { worldInput } from './queries';

export const breakInput = worldInput.extend({ requestId: z.uuid(), treatyId: z.unknown() });
export const trustInput = worldInput;
