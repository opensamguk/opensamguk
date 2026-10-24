import {
  validateMap,
  validateScenario,
  validateUnitSet,
  validateStatRules,
  validatePortraitMap,
  type ResourceKind,
  type ResourceReport,
} from '@opensamguk/rules/resource-validation';

export type ReportView = Omit<ResourceReport<unknown>, 'value'>;
export interface VerdictContext {
  scenarios?: ReadonlyArray<unknown>;
  map?: unknown;
}
export interface PublishVerdict {
  publishable: boolean;
  report: ReportView;
}

// content와 맥락의 JSON 선검사는 호출자가 먼저 한다. 맥락 집합 선택과 게시·저장은 하지 않는다.
export function publishVerdict(kind: ResourceKind, content: unknown, context?: VerdictContext): PublishVerdict {
  let original: ResourceReport<unknown>;
  switch (kind) {
    case 'MAP':
      original = validateMap(content, context?.scenarios === undefined ? undefined : { scenarios: context.scenarios });
      break;
    case 'SCENARIO':
      original = validateScenario(content, context?.map === undefined ? undefined : { map: context.map });
      break;
    case 'UNIT_SET':
      original = validateUnitSet(content);
      break;
    case 'STAT_RULES':
      original = validateStatRules(content);
      break;
    case 'PORTRAIT_MAP':
      original = validatePortraitMap(content);
      break;
    default:
      throw new RangeError('invalid_resource_kind');
  }
  return {
    publishable: original.status === 'pass',
    report: {
      kind: original.kind,
      status: original.status,
      issues: original.issues,
      ran: original.ran,
      skipped: original.skipped,
      truncated: original.truncated,
    },
  };
}
