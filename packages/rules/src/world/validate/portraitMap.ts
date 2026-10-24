import { portraitMapSchema } from '../resources';
import { addShapeIssues, ReportBuilder, type ResourceReport } from './issues';
import { scanLimits } from './limits';

export function validatePortraitMap(input: unknown): ResourceReport<{ portraits: Record<string, number> }> {
  const out = new ReportBuilder<{ portraits: Record<string, number> }>('PORTRAIT_MAP');
  out.did('limits');
  const limits = scanLimits('PORTRAIT_MAP', input);
  for (const item of limits.issues) out.add(item);
  if (limits.issues.length) {
    out.skip('shape', 'blocked');
    out.skip('portraits', 'blocked');
    return out.finish(null);
  }
  out.did('shape');
  const parsed = portraitMapSchema.safeParse(input);
  if (!parsed.success) {
    addShapeIssues(out, parsed.error.issues);
    out.skip('portraits', 'blocked');
    return out.finish(null);
  }
  out.did('portraits');
  return out.finish(parsed.data);
}
