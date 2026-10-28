import { z } from 'zod';

const document = z.strictObject({
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  effectiveAt: z.iso.datetime(),
});
const policySchema = z.strictObject({ terms: document, privacy: document });
export type LegalPolicy = Readonly<{
  terms: Readonly<z.infer<typeof document>>;
  privacy: Readonly<z.infer<typeof document>>;
}>;
export type ConsentDocument = 'TERMS' | 'PRIVACY';

// 본문·시행일·운영자와 보존 기준의 사용자 승인 뒤 검토 커밋에서만 현재 판을 고정한다.
const approvedPolicy: LegalPolicy | null = null;

export function resolveLegalPolicy(policy: LegalPolicy | null | undefined, now: number): LegalPolicy | null {
  const candidate = policy === undefined ? approvedPolicy : policy;
  if (candidate === null) return null;
  const parsed = policySchema.parse(candidate);
  if (!Number.isSafeInteger(now) || Object.values(parsed).some((value) => Date.parse(value.effectiveAt) > now))
    throw new Error('약관 시행 시각을 확인하세요.');
  return Object.freeze({ terms: Object.freeze(parsed.terms), privacy: Object.freeze(parsed.privacy) });
}

export function missingConsents(
  policy: LegalPolicy | null | undefined,
  records: ReadonlyArray<{ docType: string; version: string }>,
): ConsentDocument[] {
  if (!policy) return [];
  return (['TERMS', 'PRIVACY'] as const).filter(
    (docType) =>
      !records.some(
        (record) =>
          record.docType === docType && record.version === policy[docType === 'TERMS' ? 'terms' : 'privacy'].version,
      ),
  );
}
