import type { WorldInit } from '../bootstrap';
import { operationalMapSchema } from './operational';
import { operationalAnchors } from './anchors';
import { validateMap } from '../validate/map';

export function checkOperationalProfile(
  initial: Pick<WorldInit, 'ruleFeatures' | 'operationalMap' | 'cities' | 'nations'>,
) {
  const enabled = initial.ruleFeatures?.includes('operational-map') ?? false;
  if (!enabled) {
    if (Object.hasOwn(initial, 'operationalMap') || initial.cities.some((city) => Object.hasOwn(city, 'kind')))
      throw new Error('기존 지도 판에는 운영 지도 원장·거점 종류를 넣을 수 없습니다.');
    return;
  }
  const map = operationalMapSchema.parse(initial.operationalMap);
  if (validateMap(map, { scenarios: [] }).status !== 'pass') throw new Error('운영 지도의 연결망을 확인하세요.');
  const anchors = operationalAnchors(map);
  if (initial.cities.length !== anchors.length) throw new Error('운영 지도의 앵커 수가 생성 상태와 다릅니다.');
  const cities = new Map(initial.cities.map((city) => [city.cityKey, city]));
  for (const anchor of anchors) {
    const city = cities.get(anchor.id);
    if (
      !city ||
      city.kind !== anchor.kind ||
      city.name !== anchor.name ||
      city.x !== anchor.position.x ||
      city.y !== anchor.position.y ||
      city.level !== anchor.level ||
      city.region !== anchor.region ||
      JSON.stringify(city.connections) !== JSON.stringify(anchor.connections)
    )
      throw new Error('운영 지도의 앵커와 생성 상태가 다릅니다.');
    for (const field of ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const)
      if (city[field] !== anchor.initial[field] || city[`${field}Max`] !== anchor.max[field])
        throw new Error('운영 지도의 초기·최대 값과 생성 상태가 다릅니다.');
  }
  if (initial.nations.some((nation) => cities.get(nation.capitalCityKey)?.kind !== 'CITY'))
    throw new Error('수도는 경제 도시여야 합니다.');
}
