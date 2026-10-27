import {
  codeUnitCompare,
  isRecord,
  issue,
  MAX_DIAGNOSTICS,
  type Path,
  type ResourceIssue,
  type ResourceKind,
} from './issues';

export const RESOURCE_LIMITS = Object.freeze({
  cities: 1000,
  connections: 64,
  linesPerLayer: 2000,
  pointsPerLine: 10000,
  terrainPoints: 200000,
  nations: 500,
  citiesPerNation: 1000,
  ownedCities: 500000,
  generals: 10000,
  diplomacies: 10000,
  crewTypes: 500,
  armTypes: 500,
  coefficientKeys: 500,
  coefficients: 500000,
  portraits: 20000,
  contextScenarios: 32,
  diagnostics: MAX_DIAGNOSTICS,
  canvasSide: 4096,
  canvasArea: 4194304,
} as const);
export interface ScenarioCounts {
  nations: number;
  generals: number;
  diplomacies: number;
  ownedCities: number;
}
export interface LimitResult {
  issues: ResourceIssue[];
  counts: ScenarioCounts;
}

export function scanLimits(kind: ResourceKind, input: unknown): LimitResult {
  const issues: ResourceIssue[] = [];
  const counts: ScenarioCounts = { nations: 0, generals: 0, diplomacies: 0, ownedCities: 0 };
  const out = { issues, counts };
  if (!isRecord(input)) return out;
  const tooLarge = (path: Path, max: number) =>
    issues.push(issue('resource-too-large', { kind: 'path', path }, { max }));
  const array = (value: unknown, max: number, path: Path): unknown[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    if (value.length > max) {
      tooLarge(path, max);
      return undefined;
    }
    return value;
  };
  const keys = (value: unknown, max: number, path: Path): string[] | undefined => {
    if (!isRecord(value)) return undefined;
    const found = Object.keys(value);
    if (found.length > max) {
      tooLarge(path, max);
      return undefined;
    }
    return found.sort(codeUnitCompare);
  };
  if (kind === 'MAP') {
    if (input.version === 3) {
      array(input.sites, 500, ['sites']);
      const routes = array(input.routes, 2000, ['routes']);
      routes?.forEach((route, i) => {
        if (isRecord(route)) array(route.via, 200, ['routes', i, 'via']);
      });
    }
    const cities = array(input.cities, RESOURCE_LIMITS.cities, ['cities']);
    cities?.forEach((city, i) => {
      if (isRecord(city)) array(city.connections, RESOURCE_LIMITS.connections, ['cities', i, 'connections']);
    });
    if (isRecord(input.terrain)) {
      const terrain = input.terrain;
      const layers = ['coast', 'lakes', 'mountains', 'rivers'] as const;
      const lines = layers.map((layer) => array(terrain[layer], RESOURCE_LIMITS.linesPerLayer, ['terrain', layer]));
      const accepted: { path: Path; count: number }[] = [];
      layers.forEach((layer, n) =>
        lines[n]?.forEach((line, i) => {
          const path: Path = ['terrain', layer, i];
          const value = layer === 'rivers' ? (isRecord(line) ? line.points : undefined) : line;
          const points = array(value, RESOURCE_LIMITS.pointsPerLine, layer === 'rivers' ? [...path, 'points'] : path);
          if (points) accepted.push({ path, count: points.length });
        }),
      );
      let total = 0;
      for (const line of accepted) {
        total += line.count;
        if (total > RESOURCE_LIMITS.terrainPoints) {
          tooLarge(line.path, RESOURCE_LIMITS.terrainPoints);
          break;
        }
      }
    }
  } else if (kind === 'SCENARIO') {
    const nations = array(input.nation, RESOURCE_LIMITS.nations, ['nation']);
    counts.nations = nations?.length ?? 0;
    const owned: { path: Path; count: number }[] = [];
    nations?.forEach((nation, i) => {
      const cities = Array.isArray(nation)
        ? array(nation[8], RESOURCE_LIMITS.citiesPerNation, ['nation', i, 8])
        : undefined;
      if (cities) owned.push({ path: ['nation', i, 8], count: cities.length });
    });
    for (const entry of owned) {
      counts.ownedCities += entry.count;
      if (counts.ownedCities > RESOURCE_LIMITS.ownedCities) {
        tooLarge(entry.path, RESOURCE_LIMITS.ownedCities);
        break;
      }
    }
    counts.generals = array(input.general, RESOURCE_LIMITS.generals, ['general'])?.length ?? 0;
    counts.diplomacies = array(input.diplomacy, RESOURCE_LIMITS.diplomacies, ['diplomacy'])?.length ?? 0;
  } else if (kind === 'UNIT_SET') {
    const crew = array(input.crewTypes, RESOURCE_LIMITS.crewTypes, ['crewTypes']);
    keys(input.armTypes, RESOURCE_LIMITS.armTypes, ['armTypes']);
    const accepted: { path: Path; count: number }[] = [];
    crew?.forEach((unit, i) => {
      if (!isRecord(unit)) return;
      for (const field of ['attackCoef', 'defenceCoef'] as const) {
        const path: Path = ['crewTypes', i, field];
        const found = keys(unit[field], RESOURCE_LIMITS.coefficientKeys, path);
        if (found) accepted.push({ path, count: found.length });
      }
    });
    let total = 0;
    for (const entry of accepted) {
      total += entry.count;
      if (total > RESOURCE_LIMITS.coefficients) {
        tooLarge(entry.path, RESOURCE_LIMITS.coefficients);
        break;
      }
    }
  } else if (kind === 'PORTRAIT_MAP') keys(input.portraits, RESOURCE_LIMITS.portraits, ['portraits']);
  return out;
}
