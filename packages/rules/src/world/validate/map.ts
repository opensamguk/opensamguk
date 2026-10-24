import { mapResourceSchema, MAP_DEFAULT_CANVAS, MAP_LIMITS, type MapResource, type Point } from '../map/format';
import { isClosedRing, pointInRings } from '../map/geometry';
import { scenarioSchema } from '../resources';
import { checkId, report, resourceIssue, shapeIssues, type ValidationReport } from './issues';
import { scenarioCityIssues } from './scenario';

export interface MapValidationContext {
  expectedId?: string;
  scenarios?: ReadonlyArray<{ key: string; content: unknown }>;
}

export function validateMap(content: unknown, ctx: MapValidationContext = {}): ValidationReport<MapResource> {
  const parsed = mapResourceSchema.safeParse(content);
  if (!parsed.success) return report<MapResource>(null, shapeIssues(parsed.error));
  const value = parsed.data;
  const v2 = value.version === 2 ? value : null;
  const canvas = v2?.canvas ?? MAP_DEFAULT_CANVAS;
  const outside = ([x, y]: Point) => x < 0 || y < 0 || x > canvas.width || y > canvas.height;
  const issues = checkId(value.id, ctx.expectedId);
  if (v2 && (canvas.width !== MAP_DEFAULT_CANVAS.width || canvas.height !== MAP_DEFAULT_CANVAS.height)) {
    issues.push(resourceIssue('map-canvas-range', { width: canvas.width, height: canvas.height }));
  }
  if (value.cities.length > MAP_LIMITS.cities)
    issues.push(resourceIssue('map-too-large', { count: value.cities.length, limit: MAP_LIMITS.cities }));
  const ids = new Map<number, number>();
  const names = new Map<string, number>();
  const byId = new Map(value.cities.map((city) => [city.id, city]));
  value.cities.forEach((city, index) => {
    const target = { kind: 'city', index } as const;
    const firstId = ids.get(city.id);
    if (firstId !== undefined)
      issues.push(resourceIssue('city-id-duplicate', { id: city.id, firstIndex: firstId }, target));
    else ids.set(city.id, index);
    const name = city.name.trim();
    if (!name) issues.push(resourceIssue('city-name-empty', { id: city.id }, target));
    else {
      const firstName = names.get(name);
      if (firstName !== undefined)
        issues.push(resourceIssue('city-name-duplicate', { name, firstIndex: firstName }, target));
      else names.set(name, index);
    }
    const { x, y } = city.position;
    if (outside([x, y])) issues.push(resourceIssue('city-out-of-canvas', { name: city.name, x, y }, target));
    if (city.level < 1 || city.level > 8)
      issues.push(resourceIssue('city-level-range', { name: city.name, level: city.level }, target));
    if (city.region < 1 || city.region > 8)
      issues.push(resourceIssue('city-region-range', { name: city.name, region: city.region }, target));
    for (const field of ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const) {
      if (city.initial[field] > city.max[field])
        issues.push(
          resourceIssue(
            'city-initial-over-max',
            {
              name: city.name,
              field,
              initial: city.initial[field],
              max: city.max[field],
            },
            target,
          ),
        );
    }
    const links = new Set<number>();
    for (const cityId of city.connections) {
      if (links.has(cityId)) issues.push(resourceIssue('link-duplicate', { name: city.name, cityId }, target));
      links.add(cityId);
    }
    for (const cityId of links)
      if (cityId === city.id) issues.push(resourceIssue('link-self', { name: city.name, cityId }, target));
    for (const cityId of links)
      if (!byId.has(cityId)) issues.push(resourceIssue('link-missing-city', { name: city.name, cityId }, target));
    for (const cityId of links) {
      const other = byId.get(cityId);
      if (other && cityId !== city.id && !other.connections.includes(city.id))
        issues.push(resourceIssue('link-one-way', { name: city.name, cityId }, target));
    }
  });
  const reached = new Set<number>();
  const pending = [value.cities[0]!.id];
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i]!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const next of byId.get(id)!.connections) {
      if (!reached.has(next) && byId.get(next)?.connections.includes(id)) pending.push(next);
    }
  }
  const disconnected = value.cities.findIndex((city) => !reached.has(city.id));
  if (disconnected !== -1) {
    const city = value.cities[disconnected]!;
    issues.push(
      resourceIssue('network-split', { name: city.name, id: city.id }, { kind: 'city', index: disconnected }),
    );
  }
  if (v2) {
    let total = 0;
    for (const layer of ['coast', 'lakes', 'mountains', 'rivers'] as const) {
      v2.terrain[layer].forEach((line, index) => {
        const points = 'points' in line ? line.points : line;
        const target = { kind: 'terrain', layer, index } as const;
        const river = layer === 'rivers';
        total += points.length;
        if (river ? points.length < 2 : !isClosedRing(points))
          issues.push(resourceIssue('terrain-open', { count: points.length }, target));
        const count = new Set(points.map(([x, y]) => `${x},${y}`)).size;
        const minimum = river ? 2 : 3;
        if (count < minimum) issues.push(resourceIssue('terrain-degenerate', { count, minimum }, target));
        let outsideCount = 0;
        let firstPointIndex = -1;
        points.forEach((point, pointIndex) => {
          if (outside(point)) {
            outsideCount++;
            if (firstPointIndex === -1) firstPointIndex = pointIndex;
          }
        });
        if (outsideCount > 0)
          issues.push(resourceIssue('terrain-out-of-canvas', { outsideCount, firstPointIndex }, target));
        if (points.length > MAP_LIMITS.pointsPerLine)
          issues.push(
            resourceIssue('terrain-too-large', { count: points.length, limit: MAP_LIMITS.pointsPerLine }, target),
          );
      });
    }
    if (total > MAP_LIMITS.terrainPoints)
      issues.push(resourceIssue('terrain-too-large', { count: total, limit: MAP_LIMITS.terrainPoints }));
    if (v2.terrain.coast.length)
      value.cities.forEach((city, index) => {
        const point: Point = [city.position.x, city.position.y];
        if (!pointInRings(point, v2.terrain.coast) || pointInRings(point, v2.terrain.lakes))
          issues.push(
            resourceIssue(
              'city-off-land',
              {
                name: city.name,
                x: point[0],
                y: point[1],
              },
              { kind: 'city', index },
            ),
          );
      });
  }
  for (const scenario of ctx.scenarios ?? []) {
    const parsed = scenarioSchema.safeParse(scenario.content);
    const references = parsed.success
      ? scenarioCityIssues(parsed.data, value)
      : [resourceIssue('scenario-invalid', { key: scenario.key })];
    issues.push(
      ...references.map((issue) => ({ ...issue, resource: { kind: 'SCENARIO' as const, key: scenario.key } })),
    );
  }
  return report(value, issues);
}
