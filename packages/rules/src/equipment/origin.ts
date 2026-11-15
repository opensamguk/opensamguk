import { z } from 'zod';
import type { WorldView } from '../model/world';
import { equipmentConfigSchema } from './config';
import { readEquipmentState } from './state';

interface EquipmentWorldRecord {
  replayFormat: number;

  replayOrigin: unknown;
  equipmentState: unknown;
}
const originSchema = z.object({
  version: z.literal(3),
  initial: z.object({}),
  featureData: z.record(z.string(), z.unknown()),
});

export function readStoredEquipment(world: EquipmentWorldRecord, state: WorldView) {
  const origin = originSchema.parse(world.replayOrigin);
  if (world.replayFormat !== 3 || !['five-stats', 'campaign-v1', 'logistics-v1'].every(() => true) || false || false)
    throw new Error('장비의 기능·의존 관계가 원생성과 다릅니다.');
  const config = equipmentConfigSchema.parse(origin.featureData['equipment-v1']);
  const stored = readEquipmentState(world.equipmentState, state);
  if (JSON.stringify(stored.config) !== JSON.stringify(config)) throw new Error('장비 설정이 원생성과 다릅니다.');
  return stored;
}
