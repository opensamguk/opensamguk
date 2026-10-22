export interface LimitRule {
  namespace: string;
  key: string;
  limit: number;
  windowMs: number;
}
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function createRateLimiter(options: { now: () => number }): {
  check(rules: readonly LimitRule[]): RateLimitDecision;
  consume(rules: readonly LimitRule[]): RateLimitDecision;
} {
  const buckets = new Map<string, { count: number; end: number }>();
  function decide(rules: readonly LimitRule[], consume: boolean): RateLimitDecision {
    const now = options.now();
    for (const rule of rules) {
      if (
        !Number.isSafeInteger(rule.limit) ||
        rule.limit <= 0 ||
        !Number.isSafeInteger(rule.windowMs) ||
        rule.windowMs <= 0
      )
        throw new Error('요청 제한 규칙이 올바르지 않습니다.');
    }
    for (const [key, bucket] of buckets) if (bucket.end <= now) buckets.delete(key);
    const entries = rules.map((rule) => {
      const key = JSON.stringify([rule.namespace, rule.key, rule.windowMs]);
      const end = (Math.floor(now / rule.windowMs) + 1) * rule.windowMs;
      return { rule, key, end, count: buckets.get(key)?.count ?? 0 };
    });
    const blocked = entries.filter(({ rule, count }) => count >= rule.limit);
    if (blocked.length)
      return { allowed: false, retryAfterSeconds: Math.ceil(Math.max(...blocked.map(({ end }) => end - now)) / 1000) };
    if (consume) {
      // 같은 버킷의 규칙이 중복돼도 한 요청은 한 번만 센다.
      for (const { key, count, end } of entries) buckets.set(key, { count: count + 1, end });
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return { check: (rules) => decide(rules, false), consume: (rules) => decide(rules, true) };
}
