import { describe, expect, it } from 'vitest';
import { createRateLimiter, type LimitRule } from './rateLimit';

const rule: LimitRule = { namespace: 'test', key: 'private', limit: 1, windowMs: 60_000 };
describe('T3-04 고정 창 공유 계수기', () => {
  it('창 끝 1ms와 경계, check 비변경, 호출당 시계 한 번', () => {
    let now = 59_999;
    let reads = 0;
    const limiter = createRateLimiter({
      now: () => {
        reads++;
        return now;
      },
    });
    expect(limiter.check([rule])).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.consume([rule])).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.check([rule])).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(reads).toBe(3);
    now = 60_000;
    expect(limiter.consume([rule])).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(reads).toBe(4);
  });
  it('다중 규칙은 전부 허용일 때만 증가하고 가장 긴 차단 창을 올림한다', () => {
    const limiter = createRateLimiter({ now: () => 1 });
    const long = { ...rule, windowMs: 3_600_000 };
    expect(limiter.consume([rule, long]).allowed).toBe(true);
    const fresh = { ...rule, key: 'fresh' };
    expect(limiter.consume([fresh, rule, long])).toEqual({ allowed: false, retryAfterSeconds: 3600 });
    expect(limiter.consume([fresh]).allowed).toBe(true);
  });
  it('namespace·key·windowMs를 구별하고 중복 규칙은 한 번만 센다', () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const two = { ...rule, limit: 2 };
    expect(limiter.consume([two, two]).allowed).toBe(true);
    expect(limiter.consume([two]).allowed).toBe(true);
    expect(limiter.consume([two]).allowed).toBe(false);
    for (const different of [
      { ...rule, namespace: 'other' },
      { ...rule, key: 'other' },
      { ...rule, windowMs: 1000 },
    ])
      expect(limiter.consume([different]).allowed).toBe(true);
  });
  it('빈 규칙과 잘못된 양의 정수를 처리하며 예외 전에는 계수를 바꾸지 않는다', () => {
    const limiter = createRateLimiter({ now: () => 0 });
    expect(limiter.consume([])).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.check([])).toEqual({ allowed: true, retryAfterSeconds: 0 });
    for (const property of ['limit', 'windowMs'] as const)
      for (const value of [0, -1, 0.1, NaN, Infinity]) {
        expect(() => limiter.consume([rule, { ...rule, [property]: value }])).toThrow();
        expect(limiter.check([rule]).allowed).toBe(true);
      }
    expect(limiter.consume([rule]).allowed).toBe(true);
  });
  it('지난 버킷을 지우며 UTC 하루 경계도 epoch 기준으로 바뀐다', () => {
    let now = 86_399_999;
    const limiter = createRateLimiter({ now: () => now });
    const daily = { ...rule, windowMs: 86_400_000 };
    expect(limiter.consume([daily]).allowed).toBe(true);
    now++;
    expect(limiter.consume([daily]).allowed).toBe(true);
    now += 86_400_000;
    expect(limiter.check([daily]).allowed).toBe(true);
  });
});
