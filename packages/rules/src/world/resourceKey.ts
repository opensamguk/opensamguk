import { z } from 'zod';

export const RESOURCE_VERSION_MAX = 2_147_483_647;
const name = z
  .string()
  .min(1)
  .refine((value) => !/[^A-Za-z0-9_-]/.test(value));
export const resourceNameSchema = name.max(40);
export const resourceVersionSchema = z.number().int().min(1).max(RESOURCE_VERSION_MAX);
const invalidKey = () => new RangeError('리소스 ID와 판 번호를 확인하세요.');

export function parseResourceKey(key: string): { name: string; version: number } {
  if (typeof key !== 'string') throw invalidKey();
  // 기존 카탈로그 이름에는 길이 제한이 없다. 새 이름 입력의 40자 제한과 구분한다.
  const match = /^([A-Za-z0-9_-]+)(?:@([1-9][0-9]{0,9}))?$/.exec(key);
  if (!match || match[0] !== key) throw invalidKey();
  const version = Number(match[2] ?? 1);
  if (version > RESOURCE_VERSION_MAX) throw invalidKey();
  return { name: match[1]!, version };
}

export function formatResourceKey(ref: { name: string; version: number }): string {
  if (!name.safeParse(ref.name).success || !resourceVersionSchema.safeParse(ref.version).success) throw invalidKey();
  return ref.version === 1 ? ref.name : `${ref.name}@${ref.version}`;
}

export const resourceKeySchema = z.string().transform((value, ctx) => {
  try {
    return formatResourceKey(parseResourceKey(value));
  } catch {
    ctx.addIssue({ code: 'custom', message: '자원 판 키를 확인하세요.' });
    return z.NEVER;
  }
});
