import { z } from 'zod';
import type { WorldView } from '../model/world';
import { LINEAGE_EXITED_YEAR } from '../lineage/config';
import {
  EQUIPMENT_MAX,
  MORALE_TOOL,
  hasMoraleTool,
  hasTreatmentTool,
  equipmentConfigSchema,
  equippedItemKeySchema,
  rareEquipment,
  hasRareEquipment,
  equipmentToolKeySchema,
  equipmentTools,
  type EquipmentConfig,
} from './config';

export const equipmentSlotsSchema = z
  .strictObject({
    horse: equippedItemKeySchema.optional(),
    weapon: equippedItemKeySchema.optional(),
    book: equippedItemKeySchema.optional(),
    tool: z
      .strictObject({
        key: equipmentToolKeySchema,
        charges: z.number().int().min(1),
      })
      .refine(({ key, charges }) => charges <= equipmentTools[key].charges, '도구 사용 횟수가 한도를 넘었습니다.')
      .optional(),
  })
  .refine(
    (slots) => Object.values(slots).length > 0 && Object.values(slots).every((key) => key !== undefined),
    '빈 장비 행과 빈 장비 칸은 저장하지 않습니다.',
  );
const generalKey = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((id) => Number(id) <= EQUIPMENT_MAX);
const stateSchema = z.strictObject({
  version: z.literal(1),
  config: equipmentConfigSchema,
  generals: z.record(generalKey, equipmentSlotsSchema),
});
export type EquipmentState = z.infer<typeof stateSchema>;

export function initialEquipment(config: EquipmentConfig): EquipmentState {
  return { version: 1, config: equipmentConfigSchema.parse(config), generals: {} };
}

export function readEquipmentState(value: unknown, world: WorldView): EquipmentState {
  // record 파서가 버리는 특수 키도 먼저 장수 번호로 검사한다.
  const generals = (value as { generals?: unknown } | null)?.generals;
  if (generals && typeof generals === 'object') for (const key of Object.keys(generals)) generalKey.parse(key);
  const state = stateSchema.parse(value);
  const items = new Map(
    [...state.config.items, ...(hasRareEquipment(state.config) ? rareEquipment : [])].map((item) => [item.key, item]),
  );
  const rareKeys = new Set<string>(rareEquipment.map(({ key }) => key));
  const unique = new Set<string>();
  for (const [key, slots] of Object.entries(state.generals)) {
    const general = world.generals[Number(key)];
    if (!general || general.id !== Number(key)) throw new Error('장비 주인 장수가 없습니다.');
    if (general.activeFromYear === LINEAGE_EXITED_YEAR || world.lineage?.persons[key]?.exit)
      throw new Error('퇴장한 장수의 장비가 남아 있습니다.');
    let hasRare = false;
    for (const [slot, itemKey] of Object.entries(slots)) {
      if (slot === 'tool') {
        if (!hasTreatmentTool(state.config) || (slots.tool?.key === MORALE_TOOL.key && !hasMoraleTool(state.config)))
          throw new Error('도구를 사용할 수 없는 월드입니다.');
        continue;
      }
      const item = typeof itemKey === 'string' ? items.get(itemKey) : undefined;
      if (typeof itemKey === 'string' && rareKeys.has(itemKey)) {
        if (hasRare) throw new Error('한 장수는 명품 장비 한 점만 장착할 수 있습니다.');
        hasRare = true;
        if (unique.has(itemKey)) throw new Error('명품 장비가 중복 장착됐습니다.');
        unique.add(itemKey);
      }
      if (!item || item.slot !== slot) throw new Error('장착한 장비의 번호와 칸이 맞지 않습니다.');
    }
  }
  return state;
}
