import { z } from 'zod';

export const EQUIPMENT_MAX = 2_147_483_647;
export const EQUIPMENT_STATS = { horse: 'leadership', weapon: 'strength', book: 'intel' } as const;
export const equipmentSlotSchema = z.enum(['horse', 'weapon', 'book']);
export const equipmentKeySchema = z.string().regex(/^(horse|weapon|book)_0[1-6]$/);
const quantity = z.number().int().min(0).max(EQUIPMENT_MAX);
const itemSchema = z
  .strictObject({
    key: equipmentKeySchema,
    name: z
      .string()
      .min(1)
      .max(40)
      .refine((name) => name.trim() === name),
    slot: equipmentSlotSchema,
    grade: quantity.min(1).max(6),
    cost: quantity,
    requiredSecurity: quantity,
    stat: z.enum(['leadership', 'strength', 'intel']),
    bonus: quantity.min(1).max(6),
    goods: z.strictObject({ iron: quantity, wood: quantity, horses: quantity }),
  })
  .superRefine((item, context) => {
    if (item.key !== `${item.slot}_0${item.grade}`)
      context.addIssue({ code: 'custom', path: ['key'], message: '장비 번호·칸·등급이 맞지 않습니다.' });
    if (item.stat !== EQUIPMENT_STATS[item.slot])
      context.addIssue({ code: 'custom', path: ['stat'], message: '장비 칸의 능력치가 아닙니다.' });
  });

// 시험에서도 모든 값을 명시한다. 운영 카탈로그나 기본값을 두지 않는다 (AC-P2-12·30).
export const equipmentConfigSchema = z
  .strictObject({
    version: z.literal(1),
    items: z.array(itemSchema).min(1).max(18),
    sellRateBp: quantity.max(10_000),
    tradeExperience: quantity,
  })
  .superRefine((config, context) => {
    const keys = new Set<string>();
    for (const [index, item] of config.items.entries()) {
      if (keys.has(item.key))
        context.addIssue({ code: 'custom', path: ['items', index, 'key'], message: '장비 번호가 겹칩니다.' });
      keys.add(item.key);
    }
  });

export type EquipmentSlot = z.infer<typeof equipmentSlotSchema>;
export type EquipmentConfig = z.infer<typeof equipmentConfigSchema>;
