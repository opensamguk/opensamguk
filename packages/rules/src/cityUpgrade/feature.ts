import type { RuleFeatureDefinition } from '../ruleRegistry';
import { cloneWorld } from '../model/clone';
import { CITY_UPGRADE_FEATURE, cityUpgradeConfigSchema, initialCityUpgrade } from './state';
import { cityUpgradeCommands } from './commands';

export const cityUpgradeFeature: RuleFeatureDefinition = {
  key: CITY_UPGRADE_FEATURE,
  requires: ['construction-v1', 'city-resources-v1', 'city-scale-v1', 'prepared-turns-v1'],
  conflicts: [],
  commandBindings: cityUpgradeCommands.map((definition) => ({ definition, sliceKeys: [] })),
  checkOrigin({ data }) {
    if (data !== undefined) cityUpgradeConfigSchema.parse(data);
  },
  initReplayState(replay, { initial, data }) {
    if (data === undefined) return replay;
    const state = cloneWorld(replay.state);
    state.campaign!.cityUpgrade = initialCityUpgrade(initial, data);
    return { ...replay, state };
  },
};
