import type { RuleFeatureDefinition } from '../ruleRegistry';
import { equipmentConfigSchema } from './config';
import { initialEquipment } from './state';
import { equipmentTrade } from './trade';

// 원생성에 명시한 카탈로그와 빈 장착 상태로 시작한다.
export const equipmentFeature: RuleFeatureDefinition = {
  key: 'equipment-v1',
  requires: ['five-stats', 'campaign-v1', 'logistics-v1'],
  conflicts: [],
  commandBindings: [{ definition: equipmentTrade, sliceKeys: [] }],
  checkOrigin({ initial, data }) {
    if (Object.hasOwn(initial, 'equipment')) throw new Error('장비는 빈 장착 상태에서 시작합니다.');
    initialEquipment(equipmentConfigSchema.parse(data));
  },
  initReplayState(replay, { data }) {
    if (Object.hasOwn(replay.state, 'equipment')) throw new Error('장비 초기화가 중복됐습니다.');
    return {
      ...replay,
      state: { ...replay.state, equipment: initialEquipment(equipmentConfigSchema.parse(data)) },
    };
  },
};
