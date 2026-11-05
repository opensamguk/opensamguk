import { z } from 'zod';
import type { WorldView } from '../model/world';
import { equipmentConfigSchema } from './config';
import { readEquipmentState } from './state';

interface EquipmentWorldRecord {
  replayFormat: number;
  ruleFeatures: readonly string[];
  replayOrigin: unknown;
  equipmentState: unknown;
}
const originSchema = z.object({
  version: z.literal(3),
  initial: z.object({ ruleFeatures: z.array(z.string()) }),
  featureData: z.record(z.string(), z.unknown()),
});

export function readStoredEquipment(world: EquipmentWorldRecord, state: WorldView) {
  if (!world.ruleFeatures.includes('equipment-v1')) {
    if (world.equipmentState != null) throw new Error('장비 기능을 끈 월드에 저장 상태가 있습니다.');
    return undefined;
  }
  const origin = originSchema.parse(world.replayOrigin);
  if (
    world.replayFormat !== 3 ||
    !['five-stats', 'campaign-v1', 'logistics-v1'].every((key) => world.ruleFeatures.includes(key)) ||
    JSON.stringify(world.ruleFeatures) !== JSON.stringify(origin.initial.ruleFeatures) ||
    JSON.stringify(world.ruleFeatures) !== JSON.stringify(state.ruleFeatures)
  )
    throw new Error('장비의 기능·의존 관계가 원생성과 다릅니다.');
  const config = equipmentConfigSchema.parse(origin.featureData['equipment-v1']);
  const stored = readEquipmentState(world.equipmentState, state);
  if (JSON.stringify(stored.config) !== JSON.stringify(config)) throw new Error('장비 설정이 원생성과 다릅니다.');
  return stored;
}
