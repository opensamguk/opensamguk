import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { shapeIssues } from './issues';
import { validateMap } from './map';
import { mapFixture } from './fixtures';

describe('형식 오류 문구', () => {
  it.each([
    [z.number(), '문자', '숫자여야 함'],
    [z.int(), 1.5, '정수여야 함'],
    [z.string(), 1, '문자열이어야 함'],
    [z.boolean(), 1, '참 또는 거짓이어야 함'],
    [z.array(z.number()), 1, '목록이어야 함'],
    [z.object({}), 1, '객체여야 함'],
    [z.string().min(2), '', '길이나 값이 2 이상이어야 함'],
    [z.number().gt(2), 2, '길이나 값이 2보다 커야 함'],
    [z.string().max(2), '문자열', '길이나 값이 2 이하여야 함'],
    [z.number().lt(2), 2, '길이나 값이 2보다 작아야 함'],
    [z.literal(2), 3, '허용된 값이어야 함'],
    [z.string().regex(/^a$/), 'b', '지정된 형식이어야 함'],
    [z.union([z.string(), z.number()]), null, '허용된 형식 중 하나여야 함'],
    [z.number().multipleOf(2), 3, '값이 2의 배수여야 함'],
    [z.strictObject({}), { extra: true }, '허용하지 않은 칸이 있음: extra'],
    [z.record(z.string().min(1), z.number()), { '': 1 }, '키 형식이 맞아야 함', ['field', '']],
    [z.string().refine(() => false, 'English detail'), '', '지정된 조건에 맞아야 함'],
  ] as Array<[z.ZodType, unknown, string, (string | number)[]?]>)(
    'zod 형식 오류를 한국어와 경로로 알립니다: %s',
    (schema, content, detail, path = ['field']) => {
      const parsed = z.object({ field: schema }).safeParse({ field: content });
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('형식 오류가 필요합니다.');
      const [issue] = shapeIssues(parsed.error);
      expect(issue).toEqual({
        code: 'shape-invalid',
        severity: 'error',
        target: { kind: 'path', path },
        params: { path: path.join('.'), detail },
        message: `형식이 맞지 않습니다 (${path.join('.')}, ${detail}).`,
      });
    },
  );

  it('숫자 목록 번호를 문구와 params에 넣습니다.', () => {
    const map = mapFixture();
    const content = {
      ...map,
      cities: map.cities.map((city, index) => (index === 1 ? { ...city, level: '오류' } : city)),
    };
    expect(validateMap(content).issues).toEqual([
      {
        code: 'shape-invalid',
        severity: 'error',
        target: { kind: 'path', path: ['cities', 1, 'level'] },
        params: { path: 'cities.1.level', detail: '숫자여야 함' },
        message: '형식이 맞지 않습니다 (cities.1.level, 숫자여야 함).',
      },
    ]);
  });

  it('루트 오류와 알 수 없는 코드는 한국어 일반 문구로 알립니다.', () => {
    const error = {
      issues: [{ code: 'future-code', path: [], message: 'English detail must not leak' }],
    } as unknown as z.ZodError;
    expect(shapeIssues(error)).toEqual([
      {
        code: 'shape-invalid',
        severity: 'error',
        target: { kind: 'path', path: [] },
        params: { path: '$', detail: '지정된 조건에 맞아야 함' },
        message: '형식이 맞지 않습니다 ($, 지정된 조건에 맞아야 함).',
      },
    ]);
    expect(validateMap(null).issues[0]?.params.path).toBe('$');
  });
});
