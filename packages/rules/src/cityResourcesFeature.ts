import type { RuleFeatureDefinition } from './ruleRegistry';
import { emptyCityResourcesState } from './cityResources/state';

// 저장·명령·전투 연결이 끝나기 전에는 운영 registry에 올리지 않는다.
// 원생성의 기능 목록을 고정해 기존 campaign 판의 의미를 보존한다.
export const cityResourcesFeature: RuleFeatureDefinition = {
  key: 'city-resources-v1',
  requires: ['campaign-assignment-v2'],
  conflicts: [],
  checkOrigin({ initial, data }) {
    if (data !== undefined || Object.hasOwn(initial, 'cityResources'))
      throw new Error('도시 자원은 새 판의 빈 원장에서 시작합니다.');
  },
  initReplayState(replay) {
    if (Object.hasOwn(replay.state, 'cityResources')) throw new Error('도시 자원 초기화가 중복됐습니다.');
    return {
      ...replay,
      state: { ...replay.state, cityResources: emptyCityResourcesState(replay.state) },
    };
  },
};
