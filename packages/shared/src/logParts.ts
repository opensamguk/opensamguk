import { z } from 'zod';

const plain = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^<>\r\n]*$/u);
const name = plain(40);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const leafPartSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('text'), v: plain(400) }),
  z.strictObject({ t: z.literal('general'), id, name }),
  z.strictObject({ t: z.literal('nation'), id, name, color: z.string().regex(/^#[\da-fA-F]{6}$/) }),
  z.strictObject({ t: z.literal('city'), key: id, name }),
  z.strictObject({
    t: z.literal('num'),
    v: z.number().finite(),
    digits: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    sign: z.literal(true).optional(),
  }),
  z.strictObject({ t: z.literal('act'), key: plain(40), name }),
  z.strictObject({ t: z.literal('crew'), id, name }),
  z.strictObject({ t: z.literal('office'), level: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), name }),
]);
export const logPartSchema = z.union([
  leafPartSchema,
  z.strictObject({
    t: z.literal('tone'),
    v: z.enum(['good', 'bad', 'event', 'notice']),
    parts: z.array(leafPartSchema).min(1).max(63),
  }),
]);
export type LeafPart = z.infer<typeof leafPartSchema>;
export type LogPart = z.infer<typeof logPartSchema>;
export const logPartsSchema = z
  .array(logPartSchema)
  .min(1)
  .max(64)
  .refine(
    (parts) =>
      parts.reduce((count, part) => count + 1 + (part.t === 'tone' ? part.parts.length : 0), 0) <= 64 &&
      new TextEncoder().encode(JSON.stringify(parts)).length <= 2048,
    '기록 조각의 개수나 크기가 제한을 넘습니다.',
  );

export function logPartsToText(parts: readonly LogPart[]): string {
  return parts
    .map((part): string => {
      if (part.t === 'text') return part.v;
      if (part.t === 'tone') return logPartsToText(part.parts);
      if (part.t !== 'num') return part.name;
      const digits = part.digits ?? 0;
      return `${part.sign && part.v > 0 ? '+' : ''}${(Object.is(part.v, -0) ? 0 : part.v).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
    })
    .join('');
}

// 숫자·영문 끝 이름은 조사 없이 쓸 수 있는 문장으로 만든다.
export function koreanParticle(name: string, pair: '은/는' | '이/가' | '을/를' | '과/와' | '으로/로'): string {
  const last = name.trim().charCodeAt(name.trim().length - 1);
  if (!(last >= 0xac00 && last <= 0xd7a3)) return '';
  const final = (last - 0xac00) % 28;
  return pair.split('/')[final === 0 || (pair === '으로/로' && final === 8) ? 1 : 0]!;
}

// 시스템에서 붙인 꼬리표만 제거한다. 사용자 이름에는 호출하지 않는다.
export function logDisplayName(name: string, systemName = false): string {
  return systemName ? name.replace(/\s*[（(](?:[\p{Script=Han}]+|\d+년생)[)）]$/u, '').trim() || name : name;
}

export function readLogParts(
  parts: unknown,
  partsVersion: unknown,
): { parts?: LogPart[] | null; partsVersion?: number | null } {
  const parsed = partsVersion === 1 ? logPartsSchema.safeParse(parts) : null;
  return parsed?.success ? { parts: parsed.data, partsVersion: 1 } : { parts: null, partsVersion: null };
}

export function logPartsRecord(text: string, parts: unknown) {
  const record = readLogParts(parts, 1);
  return { text: record.parts ? logPartsToText(record.parts) : text, ...record };
}
