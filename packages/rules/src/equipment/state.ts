import { z } from 'zod';
import type { WorldView } from '../model/world';
import { LINEAGE_EXITED_YEAR } from '../lineage/config';
import {
  EQUIPMENT_MAX,
  TREATMENT_TOOL,
  hasTreatmentTool,
  equipmentConfigSchema,
  equipmentKeySchema,
  type EquipmentConfig,
} from './config';

export const equipmentSlotsSchema = z
  .strictObject({
    horse: equipmentKeySchema.optional(),
    weapon: equipmentKeySchema.optional(),
    book: equipmentKeySchema.optional(),
    tool: z
      .strictObject({
        key: z.literal(TREATMENT_TOOL.key),
        charges: z.number().int().min(1).max(TREATMENT_TOOL.charges),
      })
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
  const state = stateSchema.parse(value),
    items = new Map(state.config.items.map((item) => [item.key, item]));
  for (const [key, slots] of Object.entries(state.generals)) {
    const general = world.generals[Number(key)];
    if (!general || general.id !== Number(key)) throw new Error('장비 주인 장수가 없습니다.');
    if (general.activeFromYear === LINEAGE_EXITED_YEAR || world.lineage?.persons[key]?.exit)
      throw new Error('퇴장한 장수의 장비가 남아 있습니다.');
    for (const [slot, itemKey] of Object.entries(slots)) {
      if (slot === 'tool') {
        if (!hasTreatmentTool(state.config)) throw new Error('도구를 사용할 수 없는 월드입니다.');
        continue;
      }
      const item = typeof itemKey === 'string' ? items.get(itemKey) : undefined;
      if (!item || item.slot !== slot) throw new Error('장착한 장비의 번호와 칸이 맞지 않습니다.');
    }
  }
  return state;
}
