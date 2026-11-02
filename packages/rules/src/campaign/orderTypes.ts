import { z } from 'zod';

const integer = z.number().int().min(0).max(2_147_483_647);
const id = integer.min(1);
export const campaignOrderCommandSchema = z.strictObject({ commandKey: z.string().min(1), args: z.json() });
export const campaignOrderSlotSchema = campaignOrderCommandSchema.extend({ explicit: z.boolean().optional() });
export const campaignOrderInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('issue'), recipientId: id, command: campaignOrderCommandSchema, revision: integer }),
  z.strictObject({ type: z.literal('request'), revision: integer }),
  z.strictObject({
    type: z.literal('respond'),
    orderId: id,
    accept: z.boolean(),
    revision: integer,
    expectedTurnRevision: integer,
    expectedFirstSlot: campaignOrderSlotSchema,
  }),
]);
export const campaignOrdersSchema = z.strictObject({
  version: z.literal(1),
  nextId: id,
  items: z.array(
    z.strictObject({
      id,
      issuerId: id,
      recipientId: id,
      nationId: id,
      authority: z.enum(['DIRECT', 'SOVEREIGN']),
      command: campaignOrderCommandSchema,
      status: z.enum(['PENDING', 'READY', 'REJECTED', 'CANCELLED', 'EXECUTED', 'FAILED']),
      createdTick: integer,
      turnRevision: integer.nullable(),
      firstSlot: campaignOrderSlotSchema.nullable(),
      result: z.string().min(1).nullable(),
      resolvedTick: integer.nullable(),
    }),
  ),
});
export const campaignOrderResultSchema = z.strictObject({ orderId: id, revision: id, tick: integer });
export type CampaignOrderInput = z.infer<typeof campaignOrderInputSchema>;
export type CampaignOrder = z.infer<typeof campaignOrdersSchema>['items'][number];
export type CampaignOrderSlot = z.infer<typeof campaignOrderSlotSchema>;

export function sameOrderValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
        .join(',')}}`;
    return JSON.stringify(value) ?? 'undefined';
  };
  return canonical(a) === canonical(b);
}
