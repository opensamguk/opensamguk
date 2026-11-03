import type { RuleFeatureDefinition } from '../ruleRegistry';
import { equipmentConfigSchema } from './config';
import { initialEquipment } from './state';
import { equipmentTrade } from './trade';

// 운영 등록 전이다. 순수 재생 시험만 전용 등록표를 사용한다.
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
