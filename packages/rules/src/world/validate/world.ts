import { validateMap } from './map';
import { validateScenario } from './scenario';
import { validateUnitSet } from './unitSet';
import { validateStatRules } from './statRules';
import { validatePortraitMap } from './portraitMap';

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
  const values = Object.values(reports);
  const status = values.some((report) => report.status === 'fail')
    ? 'fail'
    : values.some((report) => report.status === 'incomplete')
      ? 'incomplete'
      : 'pass';
  return { status, ...reports };
}
