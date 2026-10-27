import { statRulesSchema, type StatRules } from '../resources';
import { report, resourceIssue, shapeIssues, type ValidationReport } from './issues';

export function validateStatRules(content: unknown): ValidationReport<{ stat: StatRules }> {
  // refine만 분리해 형식 실패와 수치 모순을 구별한다.
  const shape = statRulesSchema.extend({ stat: z.object(statRulesSchema.shape.stat.shape) });
  const parsed = shape.safeParse(content);
  if (!parsed.success) return report<{ stat: StatRules }>(null, shapeIssues(parsed.error));
  const value = parsed.data;
  const { total, min, max } = value.stat;
  const count = value.stat.count ?? 3;
  return report(
    value,
    min > max || total < count * min || total > count * max
      ? [resourceIssue('stat-rules-inconsistent', { total, min, max })]
      : [],
  );
}
import { z } from 'zod';
