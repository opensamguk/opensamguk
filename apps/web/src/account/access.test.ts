import { TRPCClientError } from '@trpc/client';
import { describe, expect, it } from 'vitest';
import { accountNext, isVerificationDenied, needsEmailVerification } from './access';

describe('T3-03 AC-M3-01 인증 이동 경계', () => {
  it('서버가 필수라고 답한 미인증 계정만 막는다', () => {
    expect(needsEmailVerification({ emailVerificationRequired: true, emailVerified: false })).toBe(true);
    expect(needsEmailVerification({ emailVerificationRequired: true, emailVerified: true })).toBe(false);
    expect(needsEmailVerification({ emailVerificationRequired: false, emailVerified: false })).toBe(false);
  });
  it('같은 월드의 검색은 보존하고 토큰이 될 수 있는 hash는 버린다', () => {
    expect(accountNext('/w/abc?city=40#token=private-fixture')).toBe('/w/abc?city=40');
    expect(accountNext('/settings/notifications')).toBe('/settings/notifications');
  });
  it.each([
    '//example.invalid',
    'https://example.invalid',
    '/\\example.invalid',
    '/\t/example.invalid',
    '/x/..//example.invalid',
    '/x/%2e%2e//example.invalid',
    '/x/.%2e//example.invalid',
    '/verify-email#token=private-fixture',
    '/reset-password?next=/w/abc',
    '/forgot-password/',
    '/x/../verify-email/',
    '/x/../login',
    undefined,
  ])('외부 이동·인증 순환을 거부한다 %j', (next) => {
    expect(accountNext(next)).toBeNull();
  });
  it.each([
    ['FORBIDDEN', 'EMAIL_NOT_VERIFIED', true],
    ['BAD_REQUEST', 'EMAIL_NOT_VERIFIED', false],
    ['FORBIDDEN', 'CONSENT_REQUIRED', false],
    ['FORBIDDEN', null, false],
    ['UNAUTHORIZED', null, false],
  ])('실제 클라이언트 코드와 사유를 함께 확인한다 %s/%s', (code, reason, expected) => {
    const error = TRPCClientError.from({ error: { code: -32000, message: 'private-fixture', data: { code, reason } } });
    expect(isVerificationDenied(error)).toBe(expected);
    expect(isVerificationDenied(new Error('EMAIL_NOT_VERIFIED'))).toBe(false);
  });
});
