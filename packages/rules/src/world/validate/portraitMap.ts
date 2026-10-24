import { portraitMapSchema } from '../resources';
import { report, resourceIssue, shapeIssues, type ResourceIssue, type ValidationReport } from './issues';

export function validatePortraitMap(content: unknown): ValidationReport<{ portraits: Record<string, number> }> {
  const parsed = portraitMapSchema.safeParse(content);
  if (!parsed.success) return report<{ portraits: Record<string, number> }>(null, shapeIssues(parsed.error));
  const first = new Map<number, string>();
  const issues: ResourceIssue[] = [];
  for (const [name, id] of Object.entries(parsed.data.portraits)) {
    const firstName = first.get(id);
    if (firstName !== undefined)
      issues.push(resourceIssue('portrait-id-duplicate', { id, firstName }, { kind: 'portrait', name }));
    else first.set(id, name);
  }
  return report(parsed.data, issues);
}
