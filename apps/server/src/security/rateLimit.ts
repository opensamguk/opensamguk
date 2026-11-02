import {
  rateLimitDecision,
  rateLimitWindows,
  type LimitRule,
  type RateLimitDecision,
} from '@opensamguk/shared/request-policy';
export type { LimitRule, RateLimitDecision } from '@opensamguk/shared/request-policy';

export function createRateLimiter(options: { now: () => number }): {
  check(rules: readonly LimitRule[]): RateLimitDecision;
  consume(rules: readonly LimitRule[]): RateLimitDecision;
} {
  const buckets = new Map<string, { count: number; end: number }>();
  function decide(rules: readonly LimitRule[], consume: boolean): RateLimitDecision {
    const now = options.now();
    const windows = rateLimitWindows(rules, now);
    for (const [key, bucket] of buckets) if (bucket.end <= now) buckets.delete(key);
    const entries = windows.map((entry) => ({ ...entry, count: buckets.get(entry.key)?.count ?? 0 }));
    const decision = rateLimitDecision(entries, now);
    if (!decision.allowed) return decision;
    if (consume) {
      // 같은 버킷의 규칙이 중복돼도 한 요청은 한 번만 센다.
      for (const { key, count, end } of entries) buckets.set(key, { count: count + 1, end });
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return { check: (rules) => decide(rules, false), consume: (rules) => decide(rules, true) };
}
