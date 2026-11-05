import { TRPCError } from '@trpc/server';
import { z } from 'zod';

export const recordTick = z.number().int().min(0).max(2_147_483_647);
export const recordId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
export const generalLogCursor = z.tuple([recordTick, recordId]);
export function encodeRecordCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
export function decodeRecordCursor<T>(value: string, schema: z.ZodType<T>): T {
  try {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw Error();
    const result = schema.parse(JSON.parse(bytes.toString('utf8')));
    if (JSON.stringify(result) !== bytes.toString('utf8')) throw Error();
    return result;
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '기록의 이전 페이지 번호를 확인하세요.' });
  }
}
