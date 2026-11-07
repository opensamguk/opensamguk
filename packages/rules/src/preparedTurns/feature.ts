import type { RuleFeatureDefinition } from '../ruleRegistry';
import { initialPreparedTurns, PREPARED_TURNS_FEATURE } from './state';

export const preparedTurnsFeature: RuleFeatureDefinition = {
  key: PREPARED_TURNS_FEATURE,
  requires: ['personnel'],
  conflicts: [],
  checkOrigin({ initial, data }) {
    if (Object.hasOwn(initial, 'preparedTurns') || data !== undefined)
      throw new Error('명령 준비는 빈 진행 상태에서 시작합니다.');
  },
  initReplayState(replay) {
    if (Object.hasOwn(replay.state, 'preparedTurns')) throw new Error('명령 준비 초기화가 중복됐습니다.');
    return { ...replay, state: { ...replay.state, preparedTurns: initialPreparedTurns() } };
  },
};
