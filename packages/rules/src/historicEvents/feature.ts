import type { RuleFeatureDefinition } from '../ruleRegistry';
import { HISTORIC_EVENTS_FEATURE, readHistoricEventsOriginConfig } from './origin';
import { initialHistoricEvents } from './state';

export const historicEventsFeature: RuleFeatureDefinition = {
  key: HISTORIC_EVENTS_FEATURE,
  requires: [],
  conflicts: [],
  checkOrigin({ initial, data }) {
    readHistoricEventsOriginConfig(initial, data);
  },
  initReplayState(replay, { initial, data }) {
    return {
      ...replay,
      historicEvents: { config: readHistoricEventsOriginConfig(initial, data), state: initialHistoricEvents() },
    };
  },
};
