import { z } from 'zod';
import { hasLegalBodies, type LegalPolicy } from '../legal/policy';

const schema = z.strictObject({
  scheme: z.literal('tombstone-v1'),
  privacyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
});
export type WithdrawalPolicy = Readonly<z.infer<typeof schema>>;

// 보존 자료·기간·근거를 사용자가 승인한 검토 커밋에서만 활성화한다.
// 2026-11-01 사용자 승인 (D-051). 보존 자료·기간은 privacy-2026-11-01 본문 6항을 따른다.
const approvedWithdrawalPolicy: WithdrawalPolicy | null = {
  scheme: 'tombstone-v1',
  privacyVersion: 'privacy-2026-11-01',
};

export function resolveWithdrawalPolicy(
  value: WithdrawalPolicy | null | undefined,
  legalPolicy: LegalPolicy | null,
): WithdrawalPolicy | null {
  const candidate = value === undefined ? approvedWithdrawalPolicy : value;
  if (candidate === null) return null;
  const parsed = schema.parse(candidate);
  if (!legalPolicy || !hasLegalBodies(legalPolicy) || parsed.privacyVersion !== legalPolicy.privacy.version)
    return null;
  return Object.freeze(parsed);
}

export function isWithdrawalTombstoneEmail(email: string): boolean {
  return /^withdrawn\+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@invalid$/i.test(email);
}
