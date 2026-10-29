import { expect, it } from 'vitest';
import { privacyStamp } from './withdrawalPolicy';

it('탈퇴 확인은 개인정보 판·시행일·본문 모두와 결합하고 미발행은 닫는다', () => {
  const document = { version: 'test-v1', effectiveAt: '2026-01-01T00:00:00.000Z', bodyText: '시험 처리방침' };
  const policy = { status: 'current' as const, terms: document, privacy: document, signupRequiresPolicy: false };
  const original = privacyStamp(policy);
  expect(original).not.toBeNull();
  for (const change of [
    { version: 'test-v2' },
    { effectiveAt: '2026-02-01T00:00:00.000Z' },
    { bodyText: '새 시험 본문' },
  ])
    expect(privacyStamp({ ...policy, privacy: { ...document, ...change } })).not.toBe(original);
  expect(privacyStamp({ ...policy, privacy: { ...document, bodyText: ' ' } })).toBeNull();
  expect(
    privacyStamp({ ...policy, privacy: { version: document.version, effectiveAt: document.effectiveAt } }),
  ).toBeNull();
  expect(privacyStamp({ status: 'pending', terms: null, privacy: null, signupRequiresPolicy: true })).toBeNull();
});
