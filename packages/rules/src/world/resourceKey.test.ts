import { describe, expect, it } from 'vitest';
import { formatResourceKey, parseResourceKey, resourceKeySchema, resourceNameSchema } from './resourceKey';

describe('T4-79 AC-P2-27 게시 판 키', () => {
  it.each([
    ['che', 'che', 1, 'che'],
    ['che@1', 'che', 1, 'che'],
    ['che@2', 'che', 2, 'che@2'],
    ['custom_191-A@2147483647', 'custom_191-A', 2147483647, 'custom_191-A@2147483647'],
  ] as const)('%s의 판과 정규형을 구분한다', (input, name, version, canonical) => {
    expect(parseResourceKey(input)).toEqual({ name, version });
    expect(formatResourceKey({ name, version })).toBe(canonical);
    expect(resourceKeySchema.parse(input)).toBe(canonical);
  });

  it.each([
    '',
    '../che',
    'che/2',
    'che@',
    '@2',
    'che@0',
    'che@01',
    'che@-1',
    'che@1.5',
    'che@1e2',
    'che@2@3',
    'che@2147483648',
    'che@12345678901',
    'che\n',
    'che\u0000',
  ])('%j는 판 키가 아니다', (key) => {
    expect(() => parseResourceKey(key)).toThrow('리소스 ID와 판 번호를 확인하세요.');
    expect(resourceKeySchema.safeParse(key).success).toBe(false);
  });

  it.each([0, -1, 1.5, 2147483648, Number.NaN, Number.POSITIVE_INFINITY])('판 %s를 출력하지 않는다', (version) => {
    expect(() => formatResourceKey({ name: 'che', version })).toThrow('리소스 ID와 판 번호를 확인하세요.');
  });

  it('기존 긴 이름의 판은 보존하며 새 이름 입력만 40자로 제한한다', () => {
    const legacy = 'old_catalog_'.repeat(10);
    expect(resourceKeySchema.parse(legacy)).toBe(legacy);
    expect(formatResourceKey(parseResourceKey(`${legacy}@2`))).toBe(`${legacy}@2`);
    expect(resourceNameSchema.safeParse(legacy).success).toBe(false);
    expect(resourceNameSchema.safeParse('a'.repeat(40)).success).toBe(true);
  });
});
