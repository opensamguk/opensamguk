import { describe, expect, it } from 'vitest';
import { validateStatRules } from './statRules';
import { codes } from './testFixtures';

describe('T4-76 능력치 규칙 검증', () => {
  it.each([
    { total: 10, min: 5, max: 10 },
    { total: 40, min: 0, max: 10 },
    { total: 15, min: 10, max: 5 },
  ])('모순된 합계·범위 %j를 구분한다', (stat) => {
    expect(codes(validateStatRules({ stat }))).toEqual(['stat-rules-inconsistent']);
  });
  it('정상 기본값과 구조 오류를 구분한다', () => {
    expect(validateStatRules({ stat: { total: 165, min: 15, max: 80 } }).status).toBe('pass');
    expect(codes(validateStatRules({ stat: { total: '165' } }))).toEqual([
      'shape-invalid',
      'shape-invalid',
      'shape-invalid',
    ]);
  });
});
