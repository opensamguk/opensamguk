import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { readCityResourcesState } from './state';

// 점령·멸망·중립화 때 같은 도시의 금·쌀은 남고 잔여 병력만 해산한다.
export function disbandCityGarrison(view: WorldView, cityKey: number) {
  if (!view.ruleFeatures?.includes('city-resources-v1')) throw new Error('도시 자원 규칙이 없는 판입니다.');
  const ledger = readCityResourcesState(view.cityResources, view),
    city = view.cities[cityKey];
  if (!city) throw new Error('해산할 도시를 확인하세요.');
  const resource = ledger.cities[String(cityKey)]!;
  const troops = resource.garrison.reduce((total, row) => total + row.troops, 0);
  const returned = Math.min(troops, Math.max(0, city.populationMax - city.population));
  const overflow = troops - returned;
  resource.garrison = [];
  const state = cloneWorld(view);
  state.cityResources = ledger;
  state.cities[cityKey]!.population += returned;
  return {
    state,
    troops,
    text: `${city.name} 수비병 해산 ${troops}명: 민간 복귀 ${returned}명, 인구 상한 밖 ${overflow}명`,
  };
}
