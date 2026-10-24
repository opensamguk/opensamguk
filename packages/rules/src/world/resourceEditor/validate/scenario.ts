import { mapResourceSchema, type MapResource } from '../map/format';
import { scenarioSchema, type ScenarioResource } from '../resources';
import { checkId, report, resourceIssue, shapeIssues, type ResourceIssue, type ValidationReport } from './issues';

export interface ScenarioValidationContext {
  map: unknown;
  mapKey?: string;
  expectedId?: string;
}

export function scenarioCityIssues(scenario: ScenarioResource, map: MapResource): ResourceIssue[] {
  const names = new Set(map.cities.map((city) => city.name));
  const issues: ResourceIssue[] = [];
  scenario.nation.forEach((nation, index) => {
    for (const city of nation[8])
      if (!names.has(city))
        issues.push(
          resourceIssue('scenario-nation-city-missing', { name: nation[0], city }, { kind: 'nation', index }),
        );
  });
  scenario.general.forEach((general, index) => {
    if (general[4] !== null && !names.has(general[4]))
      issues.push(
        resourceIssue(
          'scenario-general-city-missing',
          { name: general[1], city: general[4] },
          { kind: 'general', index },
        ),
      );
  });
  return issues;
}

export function validateScenario(content: unknown, ctx: ScenarioValidationContext): ValidationReport<ScenarioResource> {
  const parsed = scenarioSchema.safeParse(content);
  if (!parsed.success) return report<ScenarioResource>(null, shapeIssues(parsed.error));
  const value = parsed.data;
  const map = mapResourceSchema.safeParse(ctx.map);
  const issues = checkId(value.id, ctx.expectedId);
  if (!map.success) issues.push(resourceIssue('scenario-map-invalid', {}));
  const refs = map.success ? scenarioCityIssues(value, map.data) : [];
  const nationNames = new Map<string, number>();
  const owners = new Map<string, number>();
  value.nation.forEach((nation, index) => {
    const target = { kind: 'nation', index } as const;
    const name = nation[0].trim();
    const firstIndex = nationNames.get(name);
    if (firstIndex !== undefined)
      issues.push(resourceIssue('scenario-nation-name-duplicate', { name, firstIndex }, target));
    else nationNames.set(name, index);
    issues.push(...refs.filter((issue) => issue.target.kind === 'nation' && issue.target.index === index));
    for (const city of nation[8]) {
      const firstIndex = owners.get(city);
      if (firstIndex !== undefined)
        issues.push(resourceIssue('scenario-city-owner-duplicate', { city, firstIndex }, target));
      else owners.set(city, index);
    }
  });
  const generalNames = new Map<string, number>();
  value.general.forEach((general, index) => {
    const target = { kind: 'general', index } as const;
    const name = general[1];
    const firstIndex = generalNames.get(name);
    if (firstIndex !== undefined)
      issues.push(resourceIssue('scenario-general-name-duplicate', { name, firstIndex }, target));
    else generalNames.set(name, index);
    if (general[3] > value.nation.length)
      issues.push(resourceIssue('scenario-general-nation-missing', { name, nationId: general[3] }, target));
    issues.push(...refs.filter((issue) => issue.target.kind === 'general' && issue.target.index === index));
    if (general[9] > general[10])
      issues.push(
        resourceIssue('scenario-general-years', { name, birthYear: general[9], deathYear: general[10] }, target),
      );
  });
  const pairs = new Map<string, number>();
  const warnings: ResourceIssue[] = [];
  value.diplomacy.forEach(([nationA, nationB], index) => {
    const target = { kind: 'diplomacy', index } as const;
    if (nationA === nationB || nationA > value.nation.length || nationB > value.nation.length) {
      issues.push(resourceIssue('scenario-diplomacy-invalid', { nationA, nationB }, target));
    }
    const key = `${Math.min(nationA, nationB)}:${Math.max(nationA, nationB)}`;
    const firstIndex = pairs.get(key);
    if (firstIndex !== undefined)
      warnings.push(resourceIssue('scenario-diplomacy-duplicate', { nationA, nationB, firstIndex }, target));
    else pairs.set(key, index);
  });
  return report(value, [...issues, ...warnings]);
}
