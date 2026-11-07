import { validateMap } from './map';
import { validateScenario } from './scenario';
import { validateUnitSet } from './unitSet';
import { validateStatRules } from './statRules';
import { validatePortraitMap } from './portraitMap';
import { issue, type ResourceReport } from './issues';
import { legacyCheCrewRegionsMatch } from '../crewRegions';
import { scenarioStatRulesMatch } from '../resources';

export function validateWorldResources(input: {
  map: unknown;
  scenario: unknown;
  unitSet: unknown;
  statRules: unknown;
  portraitMap?: unknown;
}) {
  const reports = {
    map: validateMap(input.map, { scenarios: [] }),
    scenario: validateScenario(input.scenario, { map: input.map }),
    unitSet: validateUnitSet(input.unitSet),
    statRules: validateStatRules(input.statRules),
    portraitMap: validatePortraitMap(input.portraitMap ?? { portraits: {} }),
  };
  const requiredUnitSet = reports.scenario.value?.requiredUnitSet;
  if (
    reports.unitSet.status === 'pass' &&
    reports.unitSet.value &&
    requiredUnitSet !== undefined &&
    reports.unitSet.value.id !== requiredUnitSet
  ) {
    reports.unitSet.status = 'fail';
    reports.unitSet.issues.push(issue('shape-invalid', { kind: 'path', path: ['id'] }, { expected: requiredUnitSet }));
  }
  if (
    reports.map.status === 'pass' &&
    reports.map.value &&
    reports.unitSet.status === 'pass' &&
    reports.unitSet.value &&
    !legacyCheCrewRegionsMatch(reports.unitSet.value, reports.map.value)
  ) {
    reports.unitSet.status = 'fail';
    reports.unitSet.issues.push(
      issue(
        'shape-invalid',
        { kind: 'path', path: ['crewTypes'] },
        {
          expected: `${(reports.unitSet.value.legacyCheMapIds ?? ['che']).join('·')} 지도`,
        },
      ),
    );
  }
  if (
    reports.scenario.value &&
    reports.statRules.value &&
    !scenarioStatRulesMatch(reports.scenario.value, reports.statRules.value.stat)
  ) {
    reports.statRules.status = 'fail';
    reports.statRules.issues.push(issue('scenario-stat-rules-mismatch', { kind: 'path', path: ['stat'] }));
  }
  const values = Object.values(reports);
  const status: ResourceReport<unknown>['status'] = values.some((report) => report.status === 'fail')
    ? 'fail'
    : values.some((report) => report.status === 'incomplete')
      ? 'incomplete'
      : 'pass';
  return { status, ...reports };
}
