import { z } from 'zod';

export const STRATAGEM_CARD_KINDS = [
  'fire_attack',
  'sabotage',
  'incite',
  'plunder',
  'nation_mobilize',
  'nation_rivalry',
  'nation_raid',
  'trap',
] as const;
export const cardQuantity = z.number().int().min(0).max(2_147_483_647);
export const cardId = cardQuantity.min(1);
export const cardKindSchema = z.enum(STRATAGEM_CARD_KINDS);
export type CardKind = z.infer<typeof cardKindSchema>;

// 모든 값은 원생성에서 명시한다. 공개 프로필의 기본값을 만들지 않는다.
export const stratagemCardsConfigSchema = z.strictObject({
  version: z.literal(1),
  capacity: z.literal(3),
  deck: z
    .array(z.strictObject({ kind: cardKindSchema, weight: cardQuantity.min(1).max(10_000) }))
    .min(1)
    .max(STRATAGEM_CARD_KINDS.length)
    .refine((deck) => new Set(deck.map((card) => card.kind)).size === deck.length, '패 종류가 겹칩니다.'),
  trapCountsInCapacity: z.boolean(),
  trap: z.strictObject({ lossBp: cardQuantity.max(10_000), atmosLoss: cardQuantity.max(100) }),
  campaignLoss: z.enum(['eligibleAll', 'eligibleFirst']),
  consumeOnRollFailure: z.boolean(),
  checkOnReserve: z.boolean(),
  setter: z.enum(['ruler', 'chiefs']),
  zeroForce: z.literal('cancel'),
  startHand: cardQuantity.max(3),
  trapExpiryMonths: cardQuantity.min(1).max(120).nullable(),
});
export type StratagemCardsConfig = z.infer<typeof stratagemCardsConfigSchema>;
