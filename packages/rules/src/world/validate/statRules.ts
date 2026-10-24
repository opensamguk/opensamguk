import { statRulesSchema, type StatRules } from '../resources';
import { addShapeIssues, ReportBuilder, type ResourceReport } from './issues';

export function validateStatRules(input: unknown): ResourceReport<{ stat: StatRules }> {
  const out = new ReportBuilder<{ stat: StatRules }>('STAT_RULES');
  out.did('limits');
  out.did('shape');
  const parsed = statRulesSchema.safeParse(input);
  if (!parsed.success) {
    addShapeIssues(out, parsed.error.issues, true);
    out.skip('stat', 'blocked');
    return out.finish(null);
  }
  out.did('stat');
  return out.finish(parsed.data);
}
