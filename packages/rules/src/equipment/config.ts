import { z } from 'zod';

export const EQUIPMENT_MAX = 2_147_483_647;
export const EQUIPMENT_STATS = { horse: 'leadership', weapon: 'strength', book: 'intel' } as const;
// core2026 c81d304, packages/logic/src/items/che_치료_환약.ts (MIT).
export const TREATMENT_TOOL = {
  key: 'tool_01',
  name: '환약(치료)',
  description: '장수 턴 시작 전 부상이 10 이상이면 모두 회복합니다. 3회용.',
  cost: 200,
  charges: 3,
  injuryThreshold: 10,
} as const;
// core2026 c81d304, packages/logic/src/items/che_사기_탁주.ts (MIT).
export const MORALE_TOOL = {
  key: 'tool_02',
  name: '탁주(사기)',
  description: '전투 시작 때 사기가 최대 30 오릅니다. 1회용.',
  cost: 1_000,
  charges: 1,
  requiredSecurity: 1_000,
  morale: 30,
} as const;
export const equipmentTools = { tool_01: TREATMENT_TOOL, tool_02: MORALE_TOOL };
export const equipmentToolKeySchema = z.enum(['tool_01', 'tool_02']);
export const equipmentSlotSchema = z.enum(['horse', 'weapon', 'book']);
export const equipmentKeySchema = z.string().regex(/^(horse|weapon|book)_0[1-6]$/);
export const rareEquipmentKeySchema = z.string().regex(/^(horse|weapon|book)_15$/);
export const equippedItemKeySchema = z.union([equipmentKeySchema, rareEquipmentKeySchema]);
// Names and +15 stat effects from core2026 c81d304 items (MIT). Discovery is a new rule.
export const rareEquipment = [
  { key: 'horse_15', name: '적토마', slot: 'horse', stat: 'leadership', bonus: 15, description: '통솔 +15' },
  { key: 'weapon_15', name: '의천검', slot: 'weapon', stat: 'strength', bonus: 15, description: '무력 +15' },
  { key: 'book_15', name: '손자병법', slot: 'book', stat: 'intel', bonus: 15, description: '지력 +15' },
] as const;
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

// 시험과 원생성 모두 값을 명시한다. 카탈로그로 누락 값을 채우지 않는다 (AC-P2-12·30).
const baseEquipmentConfigSchema = z.strictObject({
  version: z.literal(1),
  items: z.array(itemSchema).min(1).max(18),
  sellRateBp: quantity.max(10_000),
  tradeExperience: quantity,
  treatmentTool: z.literal(true).optional(),
  moraleTool: z.literal(true).optional(),
  rareEquipment: z.literal(true).optional(),
});
export const equipmentConfigSchema = baseEquipmentConfigSchema.superRefine((config, context) => {
  if ((config.moraleTool && !config.treatmentTool) || (config.rareEquipment && !config.moraleTool))
    context.addIssue({ code: 'custom', path: ['moraleTool'], message: '도구와 명품 사용 조건이 맞지 않습니다.' });
  const keys = new Set<string>();
  for (const [index, item] of config.items.entries()) {
    if (keys.has(item.key))
      context.addIssue({ code: 'custom', path: ['items', index, 'key'], message: '장비 번호가 겹칩니다.' });
    keys.add(item.key);
  }
});

export type EquipmentSlot = z.infer<typeof equipmentSlotSchema>;
export type EquipmentConfig = z.infer<typeof equipmentConfigSchema>;

export function hasTreatmentTool(config: Readonly<{ treatmentTool?: true } & Pick<EquipmentConfig, 'version'>>) {
  return config.treatmentTool === true;
}

export function hasMoraleTool(config: Readonly<EquipmentConfig>) {
  return 'moraleTool' in config && config.moraleTool === true;
}

export function hasRareEquipment(config: Pick<EquipmentConfig, 'version'> & { rareEquipment?: true }) {
  return 'rareEquipment' in config && config.rareEquipment === true;
}

export function equippedItem(
  config: Pick<EquipmentConfig, 'version'> & {
    items: readonly Readonly<EquipmentConfig['items'][number]>[];
    rareEquipment?: true;
  },
  key: string | undefined,
) {
  return (
    config.items.find((item) => item.key === key) ??
    (hasRareEquipment(config) ? rareEquipment.find((item) => item.key === key) : undefined)
  );
}

export function toolSaleProceeds(held: { key: keyof typeof equipmentTools; charges: number }, sellRateBp: number) {
  const tool = equipmentTools[held.key];
  const value = Math.floor((tool.cost * held.charges) / tool.charges);
  return Math.floor((value * sellRateBp) / 10_000);
}
