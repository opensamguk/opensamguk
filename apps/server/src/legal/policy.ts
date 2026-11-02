import { z } from 'zod';
import { PRIVACY_2026_11_01, TERMS_2026_11_01 } from './documents';

const document = z.strictObject({
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  effectiveAt: z.iso.datetime(),
  bodyText: z
    .string()
    .max(65536)
    .refine((value) => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 65536)
    .optional(),
});
const policySchema = z
  .strictObject({ terms: document, privacy: document })
  .refine((value) => (value.terms.bodyText === undefined) === (value.privacy.bodyText === undefined));
export type LegalPolicy = Readonly<{
  terms: Readonly<z.infer<typeof document>>;
  privacy: Readonly<z.infer<typeof document>>;
}>;
export type ConsentDocument = 'TERMS' | 'PRIVACY';
export type PublishedLegalPolicy = Readonly<{
  terms: LegalPolicy['terms'] & Readonly<{ bodyText: string }>;
  privacy: LegalPolicy['privacy'] & Readonly<{ bodyText: string }>;
}>;

export function hasLegalBodies(policy: LegalPolicy): policy is PublishedLegalPolicy {
  return typeof policy.terms.bodyText === 'string' && typeof policy.privacy.bodyText === 'string';
}

// 본문·시행일·운영자와 보존 기준의 사용자 승인 뒤 검토 커밋에서만 현재 판을 고정한다.
// 2026-11-01 사용자 승인 (D-051). 시행일은 한국 시각 0시다.
const approvedPolicy: PublishedLegalPolicy | null = {
  terms: { version: 'terms-2026-11-01', effectiveAt: '2026-10-31T15:00:00Z', bodyText: TERMS_2026_11_01 },
  privacy: { version: 'privacy-2026-11-01', effectiveAt: '2026-10-31T15:00:00Z', bodyText: PRIVACY_2026_11_01 },
};

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
