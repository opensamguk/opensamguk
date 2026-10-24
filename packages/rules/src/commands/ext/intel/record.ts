import { z } from 'zod';
import type { ExtSlice, ExtStateRegistry } from '../state';

const integer = z.number().int().nonnegative();
const key = z.string().regex(/^[1-9][0-9]{0,9}$/);
const techSchema = z.enum(['overwhelming', 'ahead', 'even', 'behind', 'far_behind']);
export type IntelTech = z.infer<typeof techSchema>;

export const intelRecordSchema = z
  .strictObject({
    tick: integer,
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    owner: z.strictObject({ id: integer, name: z.string(), color: z.string() }).nullable(),
    population: integer,
    populationMax: integer,
    trust: z.number().min(0).max(100),
    generals: integer,
    crew: integer,
    domestic: z
      .strictObject({
        agriculture: integer,
        agricultureMax: integer,
        commerce: integer,
        commerceMax: integer,
        security: integer,
        securityMax: integer,
        defence: integer,
        defenceMax: integer,
        wall: integer,
        wallMax: integer,
      })
      .optional(),
    crewTypes: z.array(z.strictObject({ crewType: integer, generals: integer })).optional(),
    tech: techSchema.optional(),
  })
  .refine((record) => {
    for (const [field, required] of [
      ['domestic', record.level <= 2],
      ['crewTypes', record.level === 1],
      ['tech', record.level === 1 && record.owner !== null],
    ] as const) {
      if (Object.hasOwn(record, field) !== required || (required && record[field] === undefined)) return false;
    }
    return record.crewTypes?.every((row, i, rows) => i === 0 || rows[i - 1]!.crewType < row.crewType) ?? true;
  });

type IntelRecordFields = z.infer<typeof intelRecordSchema>;
// 선택 칸은 생략하며 명시적인 undefined는 JSON 상태에 넣지 않는다.
export type IntelRecord = { [K in keyof IntelRecordFields]: Exclude<IntelRecordFields[K], undefined> };
export type IntelSliceValue = Record<string, Record<string, IntelRecord>>;
function keyed<T extends z.ZodType>(schema: T) {
  // z.record가 __proto__ 키를 버리기 전에 검사한다.
  return z.preprocess(
    (value, context) => {
      if (value !== null && typeof value === 'object' && Object.hasOwn(value, '__proto__')) {
        context.addIssue({ code: 'custom', message: '잘못된 기록 키입니다.' });
        return z.NEVER;
      }
      return value;
    },
    z.record(key, schema),
  );
}
export const intelSliceSchema = keyed(keyed(intelRecordSchema));
const createIntel: ExtSlice<IntelSliceValue>['create'] = () => ({});

export const intelSlice = {
  key: 'intel',
  create: createIntel,
  clone: (value) => structuredClone(value) as IntelSliceValue,
  validate: (value): value is IntelSliceValue => intelSliceSchema.safeParse(value).success,
} satisfies ExtSlice;

export const spyBinding = {
  commandKey: 'spy',
  target: 'general',
  sliceKeys: ['intel'],
} as const satisfies ExtStateRegistry['bindings'][number];
