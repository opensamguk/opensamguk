import { z } from 'zod';

export const notificationEvents = ['turn.failed', 'attacked', 'diplomacy.offer', 'turns.low'] as const;
export type NotificationEvent = (typeof notificationEvents)[number];
export const notificationPayloadSchema = z.strictObject({
  worldId: z.uuid(),
  worldName: z.string().min(1).max(200),
  year: z.number().int().safe(),
  month: z.number().int().min(1).max(12),
  text: z.string().min(1).max(600),
});
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;
