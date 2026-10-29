import { describe, expect, it } from 'vitest';
import { isWithdrawalTombstoneEmail, resolveWithdrawalPolicy } from './withdrawalPolicy';
import type { LegalPolicy } from '../legal/policy';

const legal: LegalPolicy = {
  terms: { version: 'terms-test', effectiveAt: '2026-01-01T00:00:00Z', bodyText: '시험 약관' },
  privacy: { version: 'privacy-test', effectiveAt: '2026-01-01T00:00:00Z', bodyText: '시험 개인정보 처리 기준' },
};
const policy = { scheme: 'tombstone-v1' as const, privacyVersion: 'privacy-test' };

describe('T3-02 AC-M3-02 탈퇴 정책의 명시적 활성화 경계', () => {
  it('기본값과 명시적 null은 약관이 있어도 탈퇴 처리를 활성화하지 않는다', () => {
    expect(resolveWithdrawalPolicy(undefined, legal)).toBeNull();
    expect(resolveWithdrawalPolicy(null, legal)).toBeNull();
    expect(resolveWithdrawalPolicy(policy, null)).toBeNull();
  });
  it('시험 정책도 현재 개인정보 본문과 판이 맞아야 한다', () => {
    expect(resolveWithdrawalPolicy({ ...policy, privacyVersion: 'old' }, legal)).toBeNull();
    const terms = { version: legal.terms.version, effectiveAt: legal.terms.effectiveAt };
    const privacy = { version: legal.privacy.version, effectiveAt: legal.privacy.effectiveAt };
    expect(resolveWithdrawalPolicy(policy, { terms, privacy })).toBeNull();
    expect(resolveWithdrawalPolicy(policy, legal)).toEqual(policy);
    expect(Object.isFrozen(resolveWithdrawalPolicy(policy, legal))).toBe(true);
  });
  it('HTTP나 설정의 추가 필드와 알 수 없는 처리 방식을 받지 않는다', () => {
    expect(() => resolveWithdrawalPolicy({ ...policy, approved: true } as typeof policy, legal)).toThrow();
    expect(() =>
      resolveWithdrawalPolicy({ ...policy, scheme: 'unknown' } as unknown as typeof policy, legal),
    ).toThrow();
  });
});

it('T3-02 AC-M3-02 정확한 UUID 묘비 주소만 예약하며 일반 주소는 유지한다', () => {
  expect(isWithdrawalTombstoneEmail('withdrawn+12345678-abcd-4000-8000-1234567890ab@invalid')).toBe(true);
  expect(isWithdrawalTombstoneEmail('WITHDRAWN+12345678-ABCD-4000-8000-1234567890AB@INVALID')).toBe(true);
  for (const email of [
    'ordinary@example.test',
    'withdrawn+not-a-uuid@invalid',
    'withdrawn+12345678-abcd-4000-8000-1234567890ab@example.invalid',
    'prefix-withdrawn+12345678-abcd-4000-8000-1234567890ab@invalid',
  ])
    expect(isWithdrawalTombstoneEmail(email)).toBe(false);
});
