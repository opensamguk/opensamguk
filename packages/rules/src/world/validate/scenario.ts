import { parseMapInput, type MapInput } from '../map/format';
import { scenarioSchema, type ScenarioResource } from '../resources';
import { addShapeIssues, issue, ReportBuilder, type ResourceReport } from './issues';
import { scanLimits } from './limits';

const groups = ['nations', 'generals', 'diplomacy', 'map-refs'] as const;
export function validateScenario(input: unknown, ctx?: { map?: unknown }): ResourceReport<ScenarioResource> {
  const out = new ReportBuilder<ScenarioResource>('SCENARIO');
  out.did('limits');
  const limits = scanLimits('SCENARIO', input);
  for (const item of limits.issues) out.add(item);
  if (limits.issues.length) {
    out.skip('shape', 'blocked');
    for (const group of groups) out.skip(group, 'blocked');
    return out.finish(null);
  }
  out.did('shape');
  const parsed = scenarioSchema.safeParse(input);
  if (!parsed.success) {
    addShapeIssues(out, parsed.error.issues);
    for (const group of groups) out.skip(group, 'blocked');
    return out.finish(null);
  }
  const scenario = parsed.data;
  out.did('nations');
  const nationNames = new Set<string>();
  const owners = new Set<string>();
  scenario.nation.forEach((nation, index) => {
    const target = { kind: 'nation', index } as const;
    if (nationNames.has(nation[0])) out.add(issue('scenario-nation-name-duplicate', target, { name: nation[0] }));
    nationNames.add(nation[0]);
    for (const name of nation[8]) {
      if (owners.has(name)) out.add(issue('scenario-city-owner-duplicate', target, { name }));
      owners.add(name);
    }
  });
  out.did('generals');
  const generalNames = new Set<string>();
  scenario.general.forEach((general, index) => {
    const target = { kind: 'general', index } as const;
    if (general[3] > scenario.nation.length)
      out.add(issue('scenario-general-nation-missing', target, { nation: general[3] }));
    if (general[9] > general[10]) out.add(issue('scenario-general-years', target));
    if (generalNames.has(general[1]))
      out.add(issue('scenario-general-name-duplicate', target, { name: general[1] }, 'warning'));
    generalNames.add(general[1]);
  });
  out.did('diplomacy');
  const pairs = new Set<string>();
  scenario.diplomacy.forEach(([a, b], index) => {
    const target = { kind: 'diplomacy', index } as const;
    if (a === b || a > scenario.nation.length || b > scenario.nation.length)
      out.add(issue('scenario-diplomacy-invalid', target, { a, b }));
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (pairs.has(key)) out.add(issue('scenario-diplomacy-duplicate', target, { a, b }, 'warning'));
    pairs.add(key);
  });
  if (ctx?.map === undefined) {
    out.skip('map-refs', 'context-missing');
    return out.finish(scenario);
  }
  const mapBuilder = new ReportBuilder<MapInput>('MAP');
  const map = parseMapInput(ctx.map, mapBuilder);
  if (!map) {
    out.skip('map-refs', 'context-invalid');
    return out.finish(scenario);
  }
  out.did('map-refs');
  const names = new Set(map.cities.map((city) => city.name));
  scenario.nation.forEach((nation, index) => {
    for (const name of nation[8])
      if (!names.has(name)) out.add(issue('scenario-nation-city-missing', { kind: 'nation', index }, { name }));
  });
  scenario.general.forEach((general, index) => {
    const name = general[4];
    if (name !== null && !names.has(name))
      out.add(issue('scenario-general-city-missing', { kind: 'general', index }, { name }));
  });
  return out.finish(scenario);
}
