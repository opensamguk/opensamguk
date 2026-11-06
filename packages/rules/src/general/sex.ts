import { z } from 'zod';
import { parseResourceKey } from '../world/resourceKey';

export const generalSexSchema = z.enum(['MALE', 'FEMALE', 'UNKNOWN']);
export const knownGeneralSexSchema = generalSexSchema.exclude(['UNKNOWN']);
export type GeneralSex = z.infer<typeof generalSexSchema>;

export const sexLedgerSchema = z
  .strictObject({
    version: z.literal(1),
    scenarios: z.array(z.string().min(1)).min(1),
    review: z.strictObject({
      status: z.literal('approved'),
      reviewer: z.string().min(1),
      evidence: z.string().min(1),
      contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    rows: z.array(
      z.strictObject({
        generalId: z.number().int().positive(),
        name: z.string().min(1),
        identity: z.string().min(1),
        sex: knownGeneralSexSchema,
        sourceId: z.string().min(1),
        sourceRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        evidence: z.strictObject({
          kind: z.literal('primary-text'),
          quotes: z.array(z.string().min(1)).min(1),
          urls: z.array(z.url()).min(1),
        }),
      }),
    ),
  })
  .refine(
    (ledger) => new Set(ledger.rows.map((row) => row.generalId)).size === ledger.rows.length,
    '성별 원장의 인물 ID가 중복됐습니다.',
  );
export type SexLedger = z.infer<typeof sexLedgerSchema>;

export function applySexLedger<G extends { id: number; name: string; sex?: GeneralSex }>(
  initial: { scenarioKey: string; generals: G[] },
  ledger: SexLedger,
): Array<G & { sex: GeneralSex }> {
  const covered = ledger.scenarios.includes(parseResourceKey(initial.scenarioKey).name);
  if (covered) {
    if (initial.generals.some((general) => Object.hasOwn(general, 'sex')))
      throw Error('성별 원장 대상 시나리오에 직접 성별을 지정할 수 없습니다.');
    const generals = new Map(initial.generals.map((general) => [general.id, general]));
    for (const row of ledger.rows)
      if (generals.get(row.generalId)?.name !== row.name)
        throw Error('성별 원장의 장수 ID·이름이 시나리오와 다릅니다.');
    const facts = new Map(ledger.rows.map((row) => [row.generalId, row.sex]));
    return initial.generals.map((general) => ({ ...general, sex: facts.get(general.id) ?? 'UNKNOWN' }));
  }
  const supplied = initial.generals.filter((general) => Object.hasOwn(general, 'sex')).length;
  if (supplied !== 0 && supplied !== initial.generals.length)
    throw Error('시나리오 장수의 성별이 일부만 지정됐습니다.');
  return initial.generals.map((general) => ({
    ...general,
    sex: supplied === 0 ? 'UNKNOWN' : generalSexSchema.parse(general.sex),
  }));
}

export function storedGeneralSex<T extends { sex?: unknown }>(row: T, lineage: boolean) {
  const { sex, ...base } = row;
  if (!lineage && sex != null) throw Error('기존 월드에 성별이 저장됐습니다.');
  return { ...base, ...(lineage ? { sex: generalSexSchema.parse(sex) } : {}) };
}

export function assertGeneralSex(general: { readonly sex?: unknown }, lineage: boolean): void {
  if (lineage) generalSexSchema.parse(general.sex);
  else if (Object.hasOwn(general, 'sex')) throw Error('끈 가문 판의 장수에 성별이 있습니다.');
}
