import type { MapInput } from './map/format';
import type { MapResource, UnitSetResource } from './resources';

export const LEGACY_CHE_REGION_NAMES = ['', '하북', '중원', '서북', '서촉', '남중', '초', '오월', '동이'] as const;

export function legacyCheCityRegions(
  map: Pick<MapResource, 'cities'>,
): NonNullable<UnitSetResource['legacyCheCityRegions']> {
  return [...map.cities].sort((left, right) => left.id - right.id).map(({ id, name, region }) => [id, name, region]);
}

export function legacyCheCrewRegionsMatch(unitSet: UnitSetResource, map: MapInput) {
  const requirements = unitSet.crewTypes.flatMap((unit) => unit.requirements ?? []);
  const expected = unitSet.legacyCheCityRegions;
  if (!expected && !requirements.some(({ kind }) => kind === 'legacyCheRegions')) return true;
  if (!(unitSet.legacyCheMapIds ?? ['che']).includes(map.id) || ('version' in map && map.version === 3)) return false;
  if (!expected || JSON.stringify(legacyCheCityRegions(map)) !== JSON.stringify(expected)) return false;
  const regions = new Set(map.cities.map((city) => city.region));
  const cities = new Set(map.cities.map((city) => city.id));
  return requirements.every((requirement) => {
    if (requirement.kind === 'legacyCheRegions') return requirement.regions.every((region) => regions.has(region));
    if (requirement.kind === 'cities') return requirement.cityKeys.every((city) => cities.has(city));
    return true;
  });
}
