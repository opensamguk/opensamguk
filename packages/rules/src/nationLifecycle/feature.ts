import type { RuleFeatureDefinition } from '../ruleRegistry';
import { nationLifecycleCommands } from './commands';
import { settleNationLifecycleMonthly } from './monthly';
import {
  assertInitialNationLifecycle,
  assertNationLifecycle,
  initialNationLifecycle,
  NATION_LIFECYCLE_FEATURE,
} from './state';

export const nationLifecycleFeature: RuleFeatureDefinition = {
  key: NATION_LIFECYCLE_FEATURE,
  requires: ['personnel'],
  conflicts: [],
  commandBindings: nationLifecycleCommands.map((definition) => ({ definition, sliceKeys: [] })),
  checkOrigin({ initial, data }) {
    assertInitialNationLifecycle(initial, true);
    if (Object.hasOwn(initial, 'nationLifecycle') || data !== undefined)
      throw new Error('국가 변천 초기 원장은 생성 자료에서 도출합니다.');
  },
  initReplayState(replay) {
    if (Object.hasOwn(replay.state, 'nationLifecycle')) throw new Error('국가 변천 초기화가 중복됐습니다.');
    const state = { ...replay.state, nationLifecycle: initialNationLifecycle(Object.values(replay.state.nations)) };
    assertNationLifecycle(state);
    return { ...replay, state };
  },
  afterAppliedInput(_before, after) {
    assertNationLifecycle(after.state);
    return after;
  },
  settleMonthly({ settled, tick }) {
    const result = settleNationLifecycleMonthly(settled.state, tick);
    return { replay: { ...settled, state: result.state }, effects: result.effects };
  },
};
