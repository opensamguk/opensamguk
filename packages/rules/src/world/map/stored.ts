import { LEGACY_OPENING_CITY_PROFILE } from '../openingCityProfile';
import { isStrategicSite, operationalMapSchema, type OperationalMapResource } from './operational';
import { z } from 'zod';

const resizeHistorySchema = z
  .looseObject({
    cityUpgrade: z.looseObject({ completed: z.record(z.string(), z.unknown()) }).optional(),
  })
  .nullish();

export function readOpeningCityProfile(origin: unknown) {
  const initial = origin && typeof origin === 'object' && 'initial' in origin ? origin.initial : undefined;
  if (!initial || typeof initial !== 'object' || !Object.hasOwn(initial, 'openingCityProfile')) return undefined;
  if (!('openingCityProfile' in initial) || initial.openingCityProfile !== LEGACY_OPENING_CITY_PROFILE)
    throw new Error('운영 지도의 개막 도시 설정을 확인하세요.');
  return initial.openingCityProfile;
}

export function readOperationalMap(value: unknown, origin?: unknown): OperationalMapResource | undefined {
  if (value == null) {
    const initial = origin && typeof origin === 'object' && 'initial' in origin ? origin.initial : undefined;
    if (initial && typeof initial === 'object' && 'operationalMap' in initial)
      throw new Error('운영 지도 원장이 생성 기록과 다릅니다.');
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
  campaignState?: unknown,
): Array<Omit<T, 'kind'> & { kind?: 'CITY' | 'PASS' | 'FIELD' }> {
  cities = cities.map((row) => {
    const city = { ...row } as T & { state?: unknown; stateTerm?: unknown; parentCityKey?: unknown };
    if (city.state == null) {
      delete city.state;
      delete city.stateTerm;
      delete city.parentCityKey;
    }
    return city;
  });
  if (!map)
    return cities.map(({ kind, ...city }) => {
      if (kind !== undefined && kind !== null) throw new Error('기존 월드에 운영 거점 종류가 있습니다.');
      return city;
    });
  const kinds = new Map(
    map.sites.flatMap((site): Array<[number, 'CITY' | 'PASS' | 'FIELD']> =>
      isStrategicSite(map, site) ? [[site.anchorKey, site.kind]] : [],
    ),
  );
  if (cities.length !== kinds.size || new Set(cities.map((city) => city.cityKey)).size !== kinds.size)
    throw new Error('저장된 운영 지도 앵커 수가 다릅니다.');
  const completed = resizeHistorySchema.parse(campaignState)?.cityUpgrade?.completed;
  return cities.map((city) => {
    const kind = kinds.get(city.cityKey);
    if (!kind || city.kind !== kind) throw new Error('저장된 운영 지도 앵커 종류가 다릅니다.');
    const stored = city as T & {
      state?: number | null;
      stateTerm?: number | null;
      parentCityKey?: number | null;
      level?: number;
    };
    if (stored.state != null) {
      if (
        !Number.isInteger(stored.state) ||
        stored.state < 0 ||
        stored.state > 49 ||
        !Number.isInteger(stored.stateTerm) ||
        stored.stateTerm! < 0
      )
        throw new Error('저장된 도시 상태를 확인하세요.');
      const source = map.sites.find((site) => 'anchorKey' in site && site.anchorKey === city.cityKey);
      if (
        source?.kind === 'CITY' &&
        source.parentCityKey !== undefined &&
        stored.parentCityKey !== source.parentCityKey &&
        !(
          source.level < 5 &&
          stored.parentCityKey === null &&
          ((stored.level !== undefined && stored.level !== source.level) ||
            Object.hasOwn(completed ?? {}, String(city.cityKey)))
        )
      )
        throw new Error('저장된 부모 도시와 지도 원장이 다릅니다.');
    }
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
      ...(site.description !== undefined ? { description: site.description } : {}),
      ...(map.siteClassification === 'd096' && site.kind === 'CITY' ? { siteLevel: site.level } : {}),
      ...(isStrategicSite(map, site) ? { anchorKey: site.anchorKey } : {}),
      ...(site.kind === 'PORT' ? { parentCityId: site.parentCityId } : {}),
    })),
    routes: map.routes,
  };
}
