import type { RuleFeatureDefinition } from '../ruleRegistry';
import { cloneWorld } from '../model/clone';
import { CITY_SCALE_FEATURE, CITY_SCALE_FIELDS, ruinMaximum } from '../world/map/cityScale';
import { checkCityScaleInitial, initialCityRuins, readCityRuins, RUIN_PERCENT } from './state';

export const cityScaleFeature: RuleFeatureDefinition = {
  key: CITY_SCALE_FEATURE,
  requires: [],
  conflicts: [],
  checkOrigin({ initial, data }) {
    if (data !== undefined || Object.hasOwn(initial, 'cityRuins'))
      throw new Error('폐허는 시나리오의 생성 원장에서 시작합니다.');
    checkCityScaleInitial(initial);
  },
  initReplayState(replay, { initial }) {
    if (Object.hasOwn(replay.state, 'cityRuins')) throw new Error('폐허 초기화가 중복됐습니다.');
    return { ...replay, state: { ...replay.state, cityRuins: initialCityRuins(initial) } };
  },
  settleMonthly({ settled }) {
    const current = readCityRuins(settled.state.cityRuins, settled.state);
    if (!current) throw new Error('폐허 복구 상태가 없습니다.');
    const state = cloneWorld(settled.state);
    const effects: { cityKey: number; from: number; to: number }[] = [];
    state.cityRuins = { version: 1, cities: [] };
    for (const row of current.cities) {
      const city = state.cities[row.cityKey]!;
      if (
        city.nationId === null ||
        !['population', 'agriculture', 'commerce'].every((field) => {
          const key = field as 'population' | 'agriculture' | 'commerce';
          return city[key] * 10 >= city[`${key}Max`] * 9;
        })
      ) {
        state.cityRuins.cities.push(row);
        continue;
      }
      const nextStage = row.stage + 1;
      const max = nextStage === 3 ? row.baseMax : ruinMaximum(row.baseMax, RUIN_PERCENT[nextStage as 1 | 2]);
      for (const field of CITY_SCALE_FIELDS) city[`${field}Max`] = max[field];
      if (row.stage !== 2) state.cityRuins.cities.push({ ...row, stage: nextStage as 1 | 2 });
      effects.push({
        cityKey: row.cityKey,
        from: RUIN_PERCENT[row.stage],
        to: nextStage === 3 ? 100 : RUIN_PERCENT[nextStage as 1 | 2],
      });
    }
    return { replay: { ...settled, state }, effects };
  },
};
