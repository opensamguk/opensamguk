import type { CityScaleRecord, CityScaleValues, ScaleAnchor } from './map/cityScale';

export const LEGACY_OPENING_CITY_PROFILE = 'legacy-research-70';

export function legacyOpeningCityValues(initial: CityScaleValues, max: CityScaleValues, occupied: boolean) {
  return {
    population: Math.round(max.population * 0.7),
    agriculture: Math.round(max.agriculture * 0.7),
    commerce: Math.round(max.commerce * 0.7),
    security: Math.round(max.security * 0.7),
    defence: occupied ? Math.round(max.defence * 0.7) : initial.defence,
    wall: occupied ? Math.round(max.wall * 0.7) : initial.wall,
    trust: 80,
  };
}

export function appliesOperationalOpening(city: Pick<ScaleAnchor, 'kind' | 'level' | 'id'>, scale?: CityScaleRecord) {
  return city.kind === 'CITY' && city.level > 0 && !scale?.cities.some((row) => row.cityKey === city.id && row.ruin);
}
