import type { InputKindDefinition, RuleFeatureDefinition } from './ruleRegistry';
import { emptyCityResourcesState } from './cityResources/state';
import { campaignArmyTypes } from './campaign/feature';
import { cityResourceInputSchema, replayCityResourceInput, validateCityResourceRecord } from './cityResources/input';
import { cloneWorld } from './model/clone';

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
  checkArchive({ origin, inputs }) {
    const armyTypes = campaignArmyTypes(origin.initial);
    for (const input of inputs) {
      if (input.kind !== 'city.resources') continue;
      validateCityResourceRecord(input);
      if (input.status === 'APPLIED' && !armyTypes.includes(cityResourceInputSchema.parse(input.payload).crewType))
        throw new Error('생성 기록에 없는 도시 병종입니다.');
    }
  },
};

export const cityResourceInputKind: InputKindDefinition = {
  kind: 'city.resources',
  feature: 'city-resources-v1',
  route: 'queued',
  apply(replay, input) {
    if (!replay.campaignArmyTypes) throw new Error('도시 자원의 생성 병종 목록이 없습니다.');
    return { ...replay, state: cloneWorld(replayCityResourceInput(replay.state, input, replay.campaignArmyTypes)) };
  },
};
