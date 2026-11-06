import type { RuleFeatureDefinition } from '../ruleRegistry';
import { nationStrategyCommands } from './commands';
import { initialNationStrategy, NATION_STRATEGY_FEATURE } from './state';

export const nationStrategyFeature: RuleFeatureDefinition = {
  key: NATION_STRATEGY_FEATURE,
  requires: ['personnel'],
  conflicts: [],
  commandBindings: nationStrategyCommands.map((definition) => ({ definition, sliceKeys: [] })),
  checkOrigin({ initial, data }) {
    if (Object.hasOwn(initial, 'nationStrategy') || data !== undefined)
      throw new Error('전략 대기는 빈 상태에서 시작합니다.');
  },
  initReplayState(replay) {
    if (Object.hasOwn(replay.state, 'nationStrategy')) throw new Error('전략 대기 초기화가 중복됐습니다.');
    return { ...replay, state: { ...replay.state, nationStrategy: initialNationStrategy() } };
  },
};
