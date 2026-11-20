import { expect, it } from 'vitest';
import { z } from 'zod';
import { errorDiagnostic } from './errorDiagnostic';

it('keeps validation reasons and source locations without input values or messages', () => {
  const result = z.object({ sex: z.enum(['MALE', 'FEMALE', 'UNKNOWN']) }).safeParse({ sex: 'secret-token' });
  if (result.success) throw new Error('expected invalid fixture');
  result.error.stack = 'secret-token\n at storedGeneralSex (E:/repo/packages/rules/src/general/sex.ts:72:44)';
  expect(errorDiagnostic(result.error)).toEqual({
    name: 'ZodError',
    locations: ['packages/rules/src/general/sex.ts:72:44'],
    issues: [{ code: 'invalid_value', path: ['[field]'] }],
  });
  expect(JSON.stringify(errorDiagnostic(result.error))).not.toContain('secret-token');
  result.error.stack = 'at E:\\repo\\packages\\rules\\src\\general\\sex.ts:72:44';
  expect(errorDiagnostic(result.error)).toMatchObject({ locations: ['packages/rules/src/general/sex.ts:72:44'] });
});

it('keeps database codes and bounded causes without SQL or credentials', () => {
  const cause = Object.assign(new Error('postgresql://user:secret@host/db'), { code: 'P1001' });
  cause.stack = 'private SQL';
  cause.cause = cause;
  const diagnostic = JSON.stringify(errorDiagnostic(new Error('private', { cause })));
  expect(diagnostic).toContain('P1001');
  expect(diagnostic).not.toMatch(/secret|postgresql|private/);
  expect(errorDiagnostic('private')).toEqual({ name: 'UnknownError' });
});
