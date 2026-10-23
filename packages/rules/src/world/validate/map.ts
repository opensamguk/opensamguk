import { MAP_DEFAULT_CANVAS, parseMapInput, type MapInput } from '../map/format';
import { scenarioSchema } from '../resources';
import { issue, ReportBuilder, type ResourceIssue, type ResourceReport } from './issues';
import { RESOURCE_LIMITS, scanLimits, type ScenarioCounts } from './limits';

const groups = ['cities', 'links', 'network', 'terrain', 'scenario-refs'] as const;
const fields = ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const;
export function validateMap(input: unknown, ctx?: { scenarios?: ReadonlyArray<unknown> }): ResourceReport<MapInput> {
  const out = new ReportBuilder<MapInput>('MAP');
  const map = parseMapInput(input, out);
  if (!map) {
    for (const group of groups) out.skip(group, 'blocked');
    return out.finish(null);
  }
  const canvas = 'version' in map ? map.canvas : MAP_DEFAULT_CANVAS;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x <= canvas.width && y <= canvas.height;
  out.did('cities');
  if (
    canvas.width > RESOURCE_LIMITS.canvasSide ||
    canvas.height > RESOURCE_LIMITS.canvasSide ||
    canvas.width * canvas.height > RESOURCE_LIMITS.canvasArea
  ) {
    out.add(issue('map-canvas-unsupported', { kind: 'root' }, { width: canvas.width, height: canvas.height }));
  }
  const ids = new Map<number, number>();
  const names = new Set<string>();
  const links = map.cities.map((city) => new Set(city.connections));
  map.cities.forEach((city, index) => {
    const target = { kind: 'city', index } as const;
    if (ids.has(city.id)) out.add(issue('city-id-duplicate', target, { id: city.id }));
    else ids.set(city.id, index);
    if (names.has(city.name)) out.add(issue('city-name-duplicate', target, { name: city.name }));
    else names.add(city.name);
    if (city.name.trim() !== city.name || !city.name.trim()) out.add(issue('city-name-blank', target, {}, 'warning'));
    if (!inside(city.position.x, city.position.y))
      out.add(issue('city-out-of-canvas', target, { x: city.position.x, y: city.position.y }));
    if (city.level < 1 || city.level > 8) out.add(issue('city-level-range', target, { level: city.level }, 'warning'));
    if (city.region < 1 || city.region > 8)
      out.add(issue('city-region-range', target, { region: city.region }, 'warning'));
    for (const field of fields)
      if (city.initial[field] > city.max[field]) out.add(issue('city-initial-over-max', target, { field }));
  });
  out.did('links');
  map.cities.forEach((city, index) => {
    const target = { kind: 'city', index } as const;
    const seen = new Set<number>();
    for (const id of city.connections) {
      if (seen.has(id)) {
        out.add(issue('link-duplicate', target, { id }));
        continue;
      }
      seen.add(id);
      if (id === city.id) {
        out.add(issue('link-self', target, { id }));
        continue;
      }
      const other = ids.get(id);
      if (other === undefined) out.add(issue('link-missing-city', target, { id }));
      else if (!links[other]!.has(city.id)) out.add(issue('link-one-way', target, { id }));
    }
  });
  out.did('network');
  const reached = new Set<number>([0]);
  const queue = [0];
  for (let next = 0; next < queue.length; next++) {
    const index = queue[next]!;
    const city = map.cities[index]!;
    for (const id of links[index]!) {
      const other = ids.get(id);
      if (other === undefined || reached.has(other) || !links[other]!.has(city.id)) continue;
      reached.add(other);
      queue.push(other);
    }
  }
  const first = map.cities.findIndex((_, index) => !reached.has(index));
  if (first !== -1)
    out.add(issue('network-split', { kind: 'city', index: first }, { count: map.cities.length - reached.size }));
  out.did('terrain');
  if ('version' in map) {
    for (const layer of ['coast', 'lakes', 'mountains', 'rivers'] as const) {
      const lines = layer === 'rivers' ? map.terrain.rivers.map((river) => river.points) : map.terrain[layer];
      lines.forEach((points, index) => {
        const target = { kind: 'terrain', layer, index } as const;
        const a = points[0];
        const z = points[points.length - 1];
        if (layer === 'rivers' ? points.length < 2 : points.length < 4 || !a || !z || a[0] !== z[0] || a[1] !== z[1]) {
          out.add(issue('terrain-open', target, { points: points.length }));
        }
        const count = points.filter(([x, y]) => !inside(x, y)).length;
        if (count) out.add(issue('terrain-out-of-canvas', target, { count }));
      });
    }
  }
  const scenarios = ctx?.scenarios;
  if (scenarios === undefined) {
    out.skip('scenario-refs', 'context-missing');
    return out.finish(map);
  }
  if (!Array.isArray(scenarios)) {
    out.skip('scenario-refs', 'context-invalid');
    return out.finish(map);
  }
  if (scenarios.length > RESOURCE_LIMITS.contextScenarios) {
    out.add(
      issue(
        'resource-too-large',
        { kind: 'root' },
        { limit: 'contextScenarios', max: RESOURCE_LIMITS.contextScenarios },
      ),
    );
    out.skip('scenario-refs', 'context-invalid');
    return out.finish(map);
  }
  const eligible: number[] = [];
  const totals: ScenarioCounts = { nations: 0, generals: 0, diplomacies: 0, ownedCities: 0 };
  for (let index = 0; index < scenarios.length; index++) {
    const limits = scanLimits('SCENARIO', scenarios[index]);
    if (limits.issues.length) {
      out.skip('scenario-refs', 'context-invalid', index);
      continue;
    }
    let overflow = false;
    for (const key of ['nations', 'generals', 'diplomacies', 'ownedCities'] as const) {
      totals[key] += limits.counts[key];
      if (totals[key] <= RESOURCE_LIMITS[key]) continue;
      const item = issue('resource-too-large', { kind: 'root' }, { limit: key, max: RESOURCE_LIMITS[key] });
      item.source = { kind: 'SCENARIO', index };
      out.add(item);
      overflow = true;
    }
    if (overflow) {
      out.skip('scenario-refs', 'context-invalid');
      return out.finish(map);
    }
    eligible.push(index);
  }
  out.did('scenario-refs');
  for (const index of eligible) {
    const parsed = scenarioSchema.safeParse(scenarios[index]);
    if (!parsed.success) {
      out.skip('scenario-refs', 'context-invalid', index);
      continue;
    }
    const source = { kind: 'SCENARIO', index } as const;
    const add = (item: ResourceIssue) => out.add({ ...item, source });
    parsed.data.nation.forEach((nation, i) => {
      for (const name of nation[8])
        if (!names.has(name)) add(issue('scenario-nation-city-missing', { kind: 'nation', index: i }, { name }));
    });
    parsed.data.general.forEach((general, i) => {
      const name = general[4];
      if (name !== null && !names.has(name))
        add(issue('scenario-general-city-missing', { kind: 'general', index: i }, { name }));
    });
  }
  return out.finish(map);
}
