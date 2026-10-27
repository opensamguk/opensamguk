import { operationalMapSchema, type OperationalMapResource } from './operational';

export function readOperationalMap(
  value: unknown,
  features: readonly string[],
  origin?: unknown,
): OperationalMapResource | undefined {
  if (!features.includes('operational-map')) {
    if (value !== null && value !== undefined) throw new Error('기존 월드에 운영 지도 원장이 있습니다.');
    return undefined;
  }
  const map = operationalMapSchema.parse(value);
  if (origin !== undefined) {
    const initial = origin && typeof origin === 'object' && 'initial' in origin ? origin.initial : undefined;
    const originalMap =
      initial && typeof initial === 'object' && 'operationalMap' in initial ? initial.operationalMap : undefined;
    if (JSON.stringify(map) !== JSON.stringify(operationalMapSchema.parse(originalMap)))
      throw new Error('운영 지도 원장이 생성 기록과 다릅니다.');
  }
  return map;
}

export function attachOperationalKinds<T extends { cityKey: number; kind?: string | null }>(
  cities: readonly T[],
  map: OperationalMapResource | undefined,
): Array<Omit<T, 'kind'> & { kind?: 'CITY' | 'PASS' }> {
  if (!map)
    return cities.map(({ kind, ...city }) => {
      if (kind !== undefined && kind !== null) throw new Error('기존 월드에 운영 거점 종류가 있습니다.');
      return city;
    });
  const kinds = new Map(
    map.sites.flatMap((site): Array<[number, 'CITY' | 'PASS']> =>
      site.kind === 'CITY' || site.kind === 'PASS' ? [[site.anchorKey, site.kind]] : [],
    ),
  );
  if (cities.length !== kinds.size || new Set(cities.map((city) => city.cityKey)).size !== kinds.size)
    throw new Error('저장된 운영 지도 앵커 수가 다릅니다.');
  return cities.map((city) => {
    const kind = kinds.get(city.cityKey);
    if (!kind || city.kind !== kind) throw new Error('저장된 운영 지도 앵커 종류가 다릅니다.');
    return { ...city, kind };
  });
}

// 공개 지도 정보에는 고정 지리만 보낸다. 초기 경제 수치는 조회 응답에 섞지 않는다.
export function operationalMapDisplay(map: OperationalMapResource) {
  return {
    version: map.version,
    id: map.id,
    canvas: map.canvas,
    basemap: map.basemap,
    sites: map.sites.map((site) => ({
      id: site.id,
      name: site.name,
      kind: site.kind,
      position: site.position,
      ...('anchorKey' in site ? { anchorKey: site.anchorKey } : {}),
      ...(site.kind === 'PORT' ? { parentCityId: site.parentCityId } : {}),
    })),
    routes: map.routes,
  };
}
