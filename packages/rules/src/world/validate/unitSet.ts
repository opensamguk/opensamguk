import { unitSetSchema, type UnitSetResource } from '../resources';
import { addShapeIssues, codeUnitCompare, issue, ReportBuilder, type ResourceReport } from './issues';
import { scanLimits } from './limits';

export function validateUnitSet(input: unknown): ResourceReport<UnitSetResource> {
  const out = new ReportBuilder<UnitSetResource>('UNIT_SET');
  out.did('limits');
  const limits = scanLimits('UNIT_SET', input);
  for (const item of limits.issues) out.add(item);
  if (limits.issues.length) {
    out.skip('shape', 'blocked');
    out.skip('crew-types', 'blocked');
    return out.finish(null);
  }
  out.did('shape');
  const parsed = unitSetSchema.safeParse(input);
  if (!parsed.success) {
    addShapeIssues(out, parsed.error.issues);
    out.skip('crew-types', 'blocked');
    return out.finish(null);
  }
  const value = parsed.data;
  out.did('crew-types');
  const ids = new Set(value.crewTypes.map((unit) => unit.id));
  const standard = value.crewTypes.find((unit) => unit.id === value.defaultCrewTypeId);
  if (!standard) out.add(issue('unitset-default-missing', { kind: 'root' }));
  if (!ids.has(1000)) out.add(issue('unitset-wall-missing', { kind: 'root' }));
  if (standard?.armType === 0) out.add(issue('unitset-default-not-recruitable', { kind: 'root' }, {}, 'warning'));
  const seen = new Set<number>();
  value.crewTypes.forEach((unit, index) => {
    const target = { kind: 'crewType', index } as const;
    if (seen.has(unit.id)) out.add(issue('unitset-crew-id-duplicate', target, { id: unit.id }));
    seen.add(unit.id);
    if (unit.armType !== 0 && !Object.hasOwn(value.armTypes, String(unit.armType)))
      out.add(issue('unitset-arm-unknown', target, { armType: unit.armType }, 'warning'));
    for (const field of ['attackCoef', 'defenceCoef'] as const) {
      for (const key of Object.keys(unit[field]).sort(codeUnitCompare)) {
        if (!Object.hasOwn(value.armTypes, key))
          out.add(issue('unitset-coef-arm-unknown', target, { field, key }, 'warning'));
      }
    }
  });
  return out.finish(value);
}
