import { describe, expect, it } from 'vitest';
import { missingConsents, resolveLegalPolicy, type LegalPolicy } from './policy';

const now = Date.parse('2026-10-28T00:00:00Z');
const policy: LegalPolicy = {
  terms: { version: 'test-terms-1', effectiveAt: '2026-10-27T00:00:00Z' },
  privacy: { version: 'test-privacy-1', effectiveAt: '2026-10-27T00:00:00Z' },
};
describe('T3-02 AC-M3-02 승인 전 판과 실제 동의 대조', () => {
  it('승인된 현재 판이 없으면 임의 판과 과거 동의를 만들지 않는다', () => {
    expect(resolveLegalPolicy(undefined, now)).toBeNull();
    expect(resolveLegalPolicy(null, now)).toBeNull();
    expect(missingConsents(null, [])).toEqual([]);
  });
  it('생성자가 가진 원본을 복사하고 중첩 필드까지 변경을 막는다', () => {
    const input = structuredClone(policy);
    const current = resolveLegalPolicy(input, now)!;
    expect(current).toEqual(input);
    expect(current).not.toBe(input);
    expect(current.terms).not.toBe(input.terms);
    expect(Object.isFrozen(current) && Object.isFrozen(current.terms) && Object.isFrozen(current.privacy)).toBe(true);
    expect(() => Object.assign(current.terms, { version: 'changed' })).toThrow();
    Object.assign(input.terms, { version: 'input-changed' });
    expect(current.terms.version).toBe('test-terms-1');
  });
  it.each([
    { terms: { ...policy.terms, version: '' }, privacy: policy.privacy },
    { terms: { ...policy.terms, version: ' bad' }, privacy: policy.privacy },
    { terms: { ...policy.terms, version: 'x'.repeat(65) }, privacy: policy.privacy },
    { terms: { ...policy.terms, effectiveAt: 'not-a-date' }, privacy: policy.privacy },
    { terms: { ...policy.terms, effectiveAt: '2026-02-30T00:00:00Z' }, privacy: policy.privacy },
    { terms: { ...policy.terms, effectiveAt: '2026-10-29T00:00:00Z' }, privacy: policy.privacy },
    { terms: { ...policy.terms, other: true }, privacy: policy.privacy },
    { terms: policy.terms },
    { ...policy, approval: 'HTTP' },
  ])('잘못된 판·시행일·누락·위조 설정을 거부한다 #%#', (input) => {
    expect(() => resolveLegalPolicy(input as LegalPolicy, now)).toThrow();
  });
  it.each([NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('잘못된 서버 시각을 거부한다 #%#', (at) => {
    expect(() => resolveLegalPolicy(policy, at)).toThrow();
  });
  it('시행 시각 경계와 문서별 현재 판을 정확히 대조한다', () => {
    expect(resolveLegalPolicy(policy, Date.parse(policy.terms.effectiveAt))).toEqual(policy);
    expect(missingConsents(policy, [])).toEqual(['TERMS', 'PRIVACY']);
    expect(missingConsents(policy, [{ docType: 'TERMS', version: 'old' }])).toEqual(['TERMS', 'PRIVACY']);
    expect(missingConsents(policy, [{ docType: 'TERMS', version: policy.terms.version }])).toEqual(['PRIVACY']);
    expect(missingConsents(policy, [{ docType: 'PRIVACY', version: policy.privacy.version }])).toEqual(['TERMS']);
    expect(
      missingConsents(policy, [
        { docType: 'TERMS', version: policy.terms.version },
        { docType: 'PRIVACY', version: policy.privacy.version },
      ]),
    ).toEqual([]);
    expect(
      missingConsents(policy, [
        { docType: 'TERMS', version: policy.privacy.version },
        { docType: 'PRIVACY', version: policy.terms.version },
      ]),
    ).toEqual(['TERMS', 'PRIVACY']);
  });
});
