import { describe, expect, it } from 'vitest';
import { emailVerificationRequired } from './verificationPolicy';

describe('AC-M3-01 운영 인증 설정', () => {
  it('기존 개발 계정은 보존하며 명시한 개발 검증에만 차단을 켠다', () => {
    expect(emailVerificationRequired({})).toBe(false);
    expect(emailVerificationRequired({ EMAIL_VERIFICATION_REQUIRED: '0' })).toBe(false);
    expect(emailVerificationRequired({ EMAIL_VERIFICATION_REQUIRED: '1' })).toBe(true);
    expect(emailVerificationRequired({}, { emailVerificationRequired: true })).toBe(true);
  });
  it.each([{}, { EMAIL_VERIFICATION_REQUIRED: '1' }])('운영 기본값은 인증 필수다 #%#', (env) => {
    expect(emailVerificationRequired({ ...env, NODE_ENV: 'production' })).toBe(true);
    expect(emailVerificationRequired(env, { production: true })).toBe(true);
  });
  it.each([
    { EMAIL_VERIFICATION_REQUIRED: '0' },
    { EMAIL_VERIFICATION_REQUIRED: '' },
    { EMAIL_VERIFICATION_REQUIRED: 'false' },
    { EMAIL_VERIFICATION_REQUIRED: ' 1' },
  ])('운영의 끄기·모호한 값은 거부한다 #%#', (env) => {
    expect(() => emailVerificationRequired({ ...env, NODE_ENV: 'production' })).toThrow();
  });
  it('생성자 옵션으로 운영 환경을 개발 환경처럼 바꿀 수 없다', () => {
    expect(() => emailVerificationRequired({ NODE_ENV: 'production' }, { production: false })).toThrow();
    expect(() => emailVerificationRequired({ NODE_ENV: 'production' }, { emailVerificationRequired: false })).toThrow();
    expect(() => emailVerificationRequired({}, { production: true, emailVerificationRequired: false })).toThrow();
  });
});
