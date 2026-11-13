import type { MapInput } from './map/format';
import type { MapResource, UnitSetResource } from './resources';

export const LEGACY_CHE_REGION_NAMES = ['', '하북', '중원', '서북', '서촉', '남중', '초', '오월', '동이'] as const;

export function legacyCheCityRegions(
  map: Pick<MapResource, 'cities'>,
): NonNullable<UnitSetResource['legacyCheCityRegions']> {
  return [...map.cities].sort((left, right) => left.id - right.id).map(({ id, name, region }) => [id, name, region]);
}

export function unitSetRegionSchemeMatches(unitSet: UnitSetResource, map: MapInput) {
  return (
    unitSet.regionScheme === undefined ||
    ('version' in map && map.version === 3 && unitSet.regionScheme === map.regionScheme)
  );
}

export function legacyCheCrewRegionsMatch(unitSet: UnitSetResource, map: MapInput) {
  const requirements = unitSet.crewTypes.flatMap((unit) => unit.requirements ?? []);
  const boundRegions = requirements.flatMap((requirement) =>
    requirement.kind === 'legacyCheRegions' || (requirement.kind === 'regions' && requirement.names)
      ? requirement.regions
      : [],
  );
  const expected = unitSet.legacyCheCityRegions;
  if (!expected && !boundRegions.length) return true;
  if (!(unitSet.legacyCheMapIds ?? ['che']).includes(map.id) || ('version' in map && map.version === 3)) return false;
  if (!expected || JSON.stringify(legacyCheCityRegions(map)) !== JSON.stringify(expected)) return false;
  const regions = new Set(map.cities.map((city) => city.region));
  const cities = new Set(map.cities.map((city) => city.id));
  return (
    boundRegions.every((region) => regions.has(region)) &&
    requirements.every(
      (requirement) => requirement.kind !== 'cities' || requirement.cityKeys.every((city) => cities.has(city)),
    )
  );
}
