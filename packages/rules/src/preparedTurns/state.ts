import { z } from 'zod';
import type { JsonValue, WorldView } from '../model/world';

export const PREPARED_TURNS_FEATURE = 'prepared-turns-v1';
const storedString = z.string().refine(
  (value) =>
    !value.includes('\u0000') &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return character.length === 2 || code < 0xd800 || code > 0xdfff;
    }),
  '저장할 문자열을 확인하세요.',
);
export const preparedArgsSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().refine((value) => !Object.is(value, -0)),
    storedString,
    z.array(preparedArgsSchema),
    z.record(storedString, preparedArgsSchema),
  ]),
);
const prepareRecordSchema = z.strictObject({
  commandKey: storedString.min(1),
  args: preparedArgsSchema,
  term: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const nationKey = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((key) => Number.isSafeInteger(Number(key)));
export const preparedTurnsSchema = z.strictObject({
  version: z.literal(1),
  nations: z.record(nationKey, z.record(z.string().regex(/^(?:[5-9]|1[0-2])$/), prepareRecordSchema)),
});
export type PrepareRecord = z.infer<typeof prepareRecordSchema>;
export type PreparedTurnsState = z.infer<typeof preparedTurnsSchema>;
export const initialPreparedTurns = (): PreparedTurnsState => ({ version: 1, nations: {} });
export function readPreparedTurns(value: unknown, world: Pick<WorldView, 'ruleFeatures'>) {
  if (!world.ruleFeatures?.includes(PREPARED_TURNS_FEATURE)) {
    if (value != null) throw new Error('준비 기능을 끈 월드에 진행 상태가 있습니다.');
    return undefined;
  }
  return preparedTurnsSchema.parse(value);
}

function sameArgs(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameArgs(value, right[index]!))
    );
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameArgs(left[key]!, right[key]!))
  );
}
export function advancePrepare(
  record: PrepareRecord | undefined,
  commandKey: string,
  rawArgs: unknown,
  preReqTurn: number,
): { phase: 'prepare'; record: PrepareRecord } | { phase: 'execute' } {
  z.number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER - 1)
    .parse(preReqTurn);
  const args = preparedArgsSchema.parse(rawArgs);
  storedString.min(1).parse(commandKey);
  if (record) prepareRecordSchema.parse(record);
  const continuing = record?.commandKey === commandKey && sameArgs(record.args, args);
  const term = continuing ? record.term + 1 : 1;
  return term <= preReqTurn ? { phase: 'prepare', record: { commandKey, args, term } } : { phase: 'execute' };
}
