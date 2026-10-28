import { describe, expect, it } from 'vitest';
import { hashToken } from './session';
import { newAccountToken } from './accountToken';

describe('계정 토큰 생성', () => {
  it.each([
    ['VERIFY_EMAIL', 86_400_000],
    ['RESET_PASSWORD', 1_800_000],
  ] as const)('%s는 원문과 다른 저장 해시와 정해진 만료 시각을 반환한다', (purpose, lifetime) => {
    const now = Date.UTC(2026, 9, 28),
      first = newAccountToken(purpose, now),
      second = newAccountToken(purpose, now);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.id).toBe(hashToken(first.token));
    expect(first.id).not.toContain(first.token);
    expect(first.expiresAt.getTime()).toBe(now + lifetime);
    expect(second.token).not.toBe(first.token);
    expect(second.id).not.toBe(first.id);
  });

  it.each([NaN, Infinity, 0.5, 8.64e15])('잘못된 시각 %s를 거부한다', (now) => {
    expect(() => newAccountToken('RESET_PASSWORD', now)).toThrow();
  });
});
