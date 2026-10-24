import { statRulesSchema, type StatRules } from '../resources';
import { report, resourceIssue, shapeIssues, type ValidationReport } from './issues';

export function validateStatRules(content: unknown): ValidationReport<{ stat: StatRules }> {
  // refine만 분리해 형식 실패와 수치 모순을 구별한다.
  const shape = statRulesSchema.extend({ stat: z.object(statRulesSchema.shape.stat.shape) });
  const parsed = shape.safeParse(content);
  if (!parsed.success) return report<{ stat: StatRules }>(null, shapeIssues(parsed.error));
  const value = parsed.data;
  const { total, min, max } = value.stat;
  return report(
    value,
    min > max || total < 3 * min || total > 3 * max
      ? [resourceIssue('stat-rules-inconsistent', { total, min, max })]
      : [],
  );
}
import { z } from 'zod';
