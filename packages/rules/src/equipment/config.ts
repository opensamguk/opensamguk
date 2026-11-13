import { z } from 'zod';
import { additionalRareEquipment } from './rareCatalog';

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
// core2026 c81d304, packages/logic/src/items/che_훈련_청주.ts (MIT).
export const TRAINING_TOOL = {
  key: 'tool_03',
  name: '청주(훈련)',
  description: '전투 시작 때 훈련이 최대 40 오릅니다. 1회용.',
  cost: 1_000,
  charges: 1,
  requiredSecurity: 1_000,
  train: 40,
} as const;
// core2026 c81d304, packages/logic/src/items/che_계략_이추.ts and che_계략_향낭.ts (MIT).
export const equipmentTools = {
  tool_01: TREATMENT_TOOL,
  tool_02: MORALE_TOOL,
  tool_03: TRAINING_TOOL,
  tool_04: {
    key: 'tool_04',
    name: '이추(계략)',
    description: '도시 계략 성공 확률 +20%p. 성공하면 소모합니다.',
    cost: 1000,
    charges: 1,
    requiredSecurity: 1000,
    stratagemBonus: 0.2,
  },
  tool_05: {
    key: 'tool_05',
    name: '향낭(계략)',
    description: '도시 계략 성공 확률 +50%p. 성공하면 소모합니다.',
    cost: 3000,
    charges: 1,
    requiredSecurity: 2000,
    stratagemBonus: 0.5,
  },
  // core2026 c81d304, packages/logic/src/items/che_저격_수극.ts (MIT).
  tool_06: {
    key: 'tool_06',
    name: '수극(저격)',
    description: '교전 시작 때 저격하고 사기 +20. 1회용.',
    cost: 1000,
    charges: 1,
    requiredSecurity: 1000,
  },
} as const;
// core2026 c81d304, packages/logic/src/items/che_약탈_옥벽.ts (MIT).
export const rareEquipmentTools = {
  tool_07: {
    key: 'tool_07',
    name: '옥벽(약탈)',
    description: '새 상대 장수와 교전할 때 20% 확률로 금·쌀의 10%를 약탈합니다.',
    cost: 200,
    charges: 1,
    slot: 'tool',
    lootChance: 0.2,
    lootShare: 0.1,
  },
  // core2026 c81d304, packages/logic/src/items/che_내정_납금박산로.ts (MIT).
  tool_08: {
    key: 'tool_08',
    name: '납금박산로(내정)',
    description: '내정 대성공 확률 +15%p.',
    cost: 200,
    charges: 1,
    slot: 'tool',
    domesticSuccess: 0.15,
  },
} as const;
export const allEquipmentTools = { ...equipmentTools, ...rareEquipmentTools };
export const equipmentToolKeySchema = z.enum(Object.keys(allEquipmentTools) as (keyof typeof allEquipmentTools)[]);
export const buyableEquipmentToolKeySchema = z.enum(Object.keys(equipmentTools) as (keyof typeof equipmentTools)[]);
export const equipmentSlotSchema = z.enum(['horse', 'weapon', 'book']);
export const equipmentKeySchema = z.string().regex(/^(horse|weapon|book)_0[1-6]$/);
export const rareEquipmentKeySchema = z.string().regex(/^(horse|weapon|book)_(15|(?:0[7-9]|1[0-5])_[가-힣0-9]+)$/);
export const equippedItemKeySchema = z.union([equipmentKeySchema, rareEquipmentKeySchema]);
// Names and +15 stat effects from core2026 c81d304 items (MIT). Discovery is a new rule.
export const rareEquipment = [
  { key: 'horse_15', name: '적토마', slot: 'horse', stat: 'leadership', bonus: 15, description: '통솔 +15' },
  { key: 'weapon_15', name: '의천검', slot: 'weapon', stat: 'strength', bonus: 15, description: '무력 +15' },
  { key: 'book_15', name: '손자병법', slot: 'book', stat: 'intel', bonus: 15, description: '지력 +15' },
] as const;
const fullRareEquipment = [...rareEquipment, ...additionalRareEquipment];
type RareEquipmentOptions = { rareEquipment?: true; fullRareEquipment?: true };

export function rareEquipmentCatalog(config: Pick<EquipmentConfig, 'version'> & RareEquipmentOptions) {
  return config.fullRareEquipment ? fullRareEquipment : hasRareEquipment(config) ? rareEquipment : [];
}

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
});
const moraleEquipmentConfigSchema = baseEquipmentConfigSchema.extend({
  treatmentTool: z.literal(true),
  moraleTool: z.literal(true),
});
const rareEquipmentConfigSchema = moraleEquipmentConfigSchema.extend({ rareEquipment: z.literal(true) });
const fullRareEquipmentConfigSchema = rareEquipmentConfigSchema.extend({ fullRareEquipment: z.literal(true) });
export const equipmentConfigSchema = z
  .union([
    baseEquipmentConfigSchema,
    baseEquipmentConfigSchema.extend({ treatmentTool: z.literal(true) }),
    moraleEquipmentConfigSchema,
    rareEquipmentConfigSchema,
    fullRareEquipmentConfigSchema,
    fullRareEquipmentConfigSchema.extend({ rareTools: z.literal(true) }),
  ])
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

export function hasTreatmentTool(config: Readonly<{ treatmentTool?: true } & Pick<EquipmentConfig, 'version'>>) {
  return config.treatmentTool === true;
}

export function hasMoraleTool(config: Readonly<EquipmentConfig>) {
  return 'moraleTool' in config && config.moraleTool === true;
}

export function availableEquipmentTools(config: Readonly<EquipmentConfig>) {
  if ('fullRareEquipment' in config) return Object.values(equipmentTools);
  if (hasMoraleTool(config)) return [TREATMENT_TOOL, MORALE_TOOL];
  return hasTreatmentTool(config) ? [TREATMENT_TOOL] : [];
}

export function hasRareEquipment(config: Pick<EquipmentConfig, 'version'> & { rareEquipment?: true }) {
  return 'rareEquipment' in config && config.rareEquipment === true;
}

export function equippedItem(
  config: Pick<EquipmentConfig, 'version'> & {
    items: readonly Readonly<EquipmentConfig['items'][number]>[];
    rareEquipment?: true;
    fullRareEquipment?: true;
  },
  key: string | undefined,
) {
  return config.items.find((item) => item.key === key) ?? rareEquipmentCatalog(config).find((item) => item.key === key);
}

export function availableRareEquipmentTools(config: Readonly<EquipmentConfig>) {
  return 'rareTools' in config && config.rareTools ? Object.values(rareEquipmentTools) : [];
}

export function toolSaleProceeds(held: { key: keyof typeof allEquipmentTools; charges: number }, sellRateBp: number) {
  const tool = allEquipmentTools[held.key];
  const value = Math.floor((tool.cost * held.charges) / tool.charges);
  return Math.floor((value * sellRateBp) / 10_000);
}
