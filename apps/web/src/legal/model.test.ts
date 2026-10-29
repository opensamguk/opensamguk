import { describe, expect, it } from 'vitest';
import { readablePolicy, signupPolicyStamp, type CurrentPolicy } from './model';

const policy = {
  status: 'current',
  signupRequiresPolicy: true,
  terms: { version: 'test-terms-1', effectiveAt: '2026-01-01T00:00:00.000Z', bodyText: '시험 이용약관' },
  privacy: { version: 'test-privacy-1', effectiveAt: '2026-01-01T00:00:00.000Z', bodyText: '시험 개인정보처리방침' },
} satisfies CurrentPolicy;

describe('T3-03 AC-M3-02 읽은 본문과 가입 경계', () => {
  it('서버가 비필수라고 답한 준비 상태만 무동의 개발 가입을 허용한다', () => {
    expect(signupPolicyStamp({ status: 'pending', terms: null, privacy: null, signupRequiresPolicy: false })).toBe(
      'pending:optional',
    );
    expect(signupPolicyStamp({ status: 'pending', terms: null, privacy: null, signupRequiresPolicy: true })).toBeNull();
    expect(signupPolicyStamp(undefined)).toBeNull();
  });
  it.each(['version', 'effectiveAt', 'bodyText'] as const)(
    '두 문서 중 한쪽의 %s가 바뀌면 기존 체크가 무효다',
    (field) => {
      for (const key of ['terms', 'privacy'] as const) {
        const changed = { ...policy, [key]: { ...policy[key], [field]: policy[key][field] + '-changed' } };
        expect(signupPolicyStamp(changed)).not.toBe(signupPolicyStamp(policy));
      }
    },
  );
  it('현재 판에 본문이 없거나 공백이면 동의를 열지 않는다', () => {
    expect(
      readablePolicy({ ...policy, terms: { version: 'legacy', effectiveAt: policy.terms.effectiveAt } }),
    ).toBeNull();
    expect(readablePolicy({ ...policy, privacy: { ...policy.privacy, bodyText: '  ' } })).toBeNull();
    expect(readablePolicy(policy)?.terms.bodyText).toBe(policy.terms.bodyText);
  });
});
