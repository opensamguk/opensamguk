import { unitSetSchema, type UnitSetResource } from '../resources';
import { checkId, report, resourceIssue, shapeIssues, type ValidationReport } from './issues';

export function validateUnitSet(
  content: unknown,
  ctx: { expectedId?: string } = {},
): ValidationReport<UnitSetResource> {
  const parsed = unitSetSchema.safeParse(content);
  if (!parsed.success) return report<UnitSetResource>(null, shapeIssues(parsed.error));
  const value = parsed.data;
  const issues = checkId(value.id, ctx.expectedId);
  const basic = value.crewTypes.find((crew) => crew.id === value.defaultCrewTypeId);
  if (!basic) issues.push(resourceIssue('unitset-default-missing', { id: value.defaultCrewTypeId }));
  if (basic?.armType === 0) issues.push(resourceIssue('unitset-default-not-recruitable', { id: basic.id }));
  if (!value.crewTypes.some((crew) => crew.id === 1000)) issues.push(resourceIssue('unitset-wall-missing', {}));
  // 계열은 사전이므로 입력 키 순서를 따른다.
  for (const key of Object.keys(value.armTypes)) {
    if (!/^[1-9]\d*$/.test(key))
      issues.push(resourceIssue('unitset-arm-key-invalid', { key }, { kind: 'armType', key }));
  }
  const ids = new Map<number, number>();
  const names = new Map<string, number>();
  value.crewTypes.forEach((crew, index) => {
    const target = { kind: 'crewType', index } as const;
    const firstId = ids.get(crew.id);
    if (firstId !== undefined)
      issues.push(resourceIssue('unitset-crew-id-duplicate', { id: crew.id, firstIndex: firstId }, target));
    else ids.set(crew.id, index);
    const firstName = names.get(crew.name);
    if (firstName !== undefined)
      issues.push(resourceIssue('unitset-crew-name-duplicate', { name: crew.name, firstIndex: firstName }, target));
    else names.set(crew.name, index);
    if (crew.armType !== 0 && !Object.hasOwn(value.armTypes, String(crew.armType)))
      issues.push(resourceIssue('unitset-crew-arm-missing', { name: crew.name, armType: crew.armType }, target));
    for (const field of ['attackCoef', 'defenceCoef'] as const) {
      for (const key of Object.keys(crew[field]))
        if (!Object.hasOwn(value.armTypes, key))
          issues.push(resourceIssue('unitset-coef-arm-missing', { name: crew.name, field, key }, target));
    }
  });
  return report(value, issues);
}
