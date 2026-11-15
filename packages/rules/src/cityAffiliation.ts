import type { WorldState, WorldView } from './model/world';
import type { InitialCity } from './world/bootstrap';

// 길 길이를 가중치로 쓰고 같은 거리에서는 키 순으로 고른다.
export function cityDistances(cities: WorldView['cities'], from: number) {
  const distances = new Map<number, number>([[from, 0]]);
  const pending = new Set(Object.keys(cities).map(Number));
  while (pending.size) {
    let key: number | undefined,
      distance = Infinity;
    for (const candidate of pending) {
      const value = distances.get(candidate) ?? Infinity;
      if (value < distance || (value === distance && key !== undefined && candidate < key)) {
        key = candidate;
        distance = value;
      }
    }
    if (key === undefined) break;
    pending.delete(key);
    const city = cities[key]!;
    for (const other of city.connections) {
      const target = cities[other];
      if (!target || !pending.has(other)) continue;
      const next = distance + Math.hypot(city.x - target.x, city.y - target.y);
      if (next < (distances.get(other) ?? Infinity)) distances.set(other, next);
    }
  }
  return distances;
}

export function assignCountyParents(cities: InitialCity[]) {
  const world = Object.fromEntries(cities.map((city) => [city.cityKey, city]));
  const major = cities.filter((city) => city.kind === 'CITY' && city.level >= 5);
  for (const city of cities) {
    if (city.kind !== 'CITY' || city.level !== 2) continue;
    const local = major.filter((parent) => parent.region === city.region);
    const distances = cityDistances(world, city.cityKey);
    const parent = (local.length ? local : major)
      .slice()
      .sort(
        (a, b) =>
          (distances.get(a.cityKey) ?? Infinity) - (distances.get(b.cityKey) ?? Infinity) || a.cityKey - b.cityKey,
      )[0];
    if (!parent || !distances.has(parent.cityKey)) throw new Error(`${city.name}: 부모 도시로 가는 길이 없습니다.`);
    city.parentCityKey = parent.cityKey;
  }
}

export function countyDetached(
  city: Pick<InitialCity, 'parentCityKey' | 'nationId'>,
  cities: Readonly<Record<number, { nationId: number | null }>>,
) {
  return city.parentCityKey != null && cities[city.parentCityKey]?.nationId !== city.nationId;
}

export function countyUndefended(world: WorldView, cityKey: number) {
  return (
    !Object.values(world.generals).some((general) => general.cityKey === cityKey && general.removedAt === undefined) &&
    !world.cityResources?.cities[String(cityKey)]?.garrison.some((row) => row.troops > 0)
  );
}

export function captureCounties(world: WorldState, parentCityKey: number) {
  const parent = world.cities[parentCityKey]!;
  for (const city of Object.values(world.cities)) {
    if (city.parentCityKey === parentCityKey && countyUndefended(world, city.cityKey)) city.nationId = parent.nationId;
  }
}

export function countyTaxDestination(world: WorldView, cityKey: number) {
  const city = world.cities[cityKey]!;
  if (city.parentCityKey == null) return cityKey;
  if (!countyDetached(city, world.cities)) return city.parentCityKey;
  const distances = cityDistances(world.cities, cityKey);
  return (
    Object.values(world.cities)
      .filter(
        (candidate) =>
          candidate.nationId === city.nationId &&
          candidate.kind !== 'PASS' &&
          candidate.kind !== 'FIELD' &&
          candidate.parentCityKey == null &&
          distances.has(candidate.cityKey),
      )
      .sort((a, b) => distances.get(a.cityKey)! - distances.get(b.cityKey)! || a.cityKey - b.cityKey)[0]?.cityKey ??
    cityKey
  );
}
