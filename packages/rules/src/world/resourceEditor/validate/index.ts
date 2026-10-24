import { validateMap, type MapValidationContext } from './map';
import { validateScenario } from './scenario';
import { validateUnitSet } from './unitSet';
import { validateStatRules } from './statRules';
import { validatePortraitMap } from './portraitMap';
import type { ResourceKind, ValidationReport } from './issues';

export * from '../map/format';
export * from '../map/geometry';
export type { ScenarioResource, UnitSetResource, StatRules } from '../resources';
export { validateMap, validateScenario, validateUnitSet, validateStatRules, validatePortraitMap };
export type { MapValidationContext } from './map';
export type { ScenarioValidationContext } from './scenario';
export { resourceIssue, RESOURCE_ISSUES } from './issues';
export type { ResourceKind, Severity, IssueTarget, ResourceIssueCode, ResourceIssue, ValidationReport } from './issues';

export function validateResource(kind: ResourceKind, content: unknown, ctx: object = {}): ValidationReport<unknown> {
  switch (kind) {
    case 'MAP':
      return validateMap(content, ctx as MapValidationContext);
    case 'SCENARIO':
      return validateScenario(content, { ...ctx, map: 'map' in ctx ? ctx.map : undefined });
    case 'UNIT_SET':
      return validateUnitSet(content, ctx);
    case 'STAT_RULES':
      return validateStatRules(content);
    case 'PORTRAIT_MAP':
      return validatePortraitMap(content);
    default:
      throw new Error('알 수 없는 자원 종류입니다.');
  }
}
