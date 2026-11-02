export interface GuardRequest {
  method: string;
  accept: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  contentType: string | undefined;
}

/** HTTP adapter는 대상 경로 선택과 응답 전송만 맡는다. */
export function requestGuard(request: GuardRequest, publicOrigin: string): { status: 403 | 415; error: string } | null {
  const sse = request.accept
    ?.split(',')
    .some((value) => value.split(';')[0]?.trim().toLowerCase() === 'text/event-stream');
  if (request.method !== 'POST' && !sse) return null;
  if (request.origin !== undefined ? request.origin !== publicOrigin : request.secFetchSite !== 'same-origin')
    return { status: 403, error: '같은 출처에서 요청하세요.' };
  if (request.method === 'POST' && request.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    return { status: 415, error: 'JSON 본문이 필요합니다.' };
  return null;
}

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

export function rateLimitWindows(rules: readonly LimitRule[], now: number) {
  return rules.map((rule) => {
    if (
      !Number.isSafeInteger(rule.limit) ||
      rule.limit <= 0 ||
      !Number.isSafeInteger(rule.windowMs) ||
      rule.windowMs <= 0
    )
      throw new Error('요청 제한 규칙이 올바르지 않습니다.');
    return {
      rule,
      key: JSON.stringify([rule.namespace, rule.key, rule.windowMs]),
      end: (Math.floor(now / rule.windowMs) + 1) * rule.windowMs,
    };
  });
}

export function rateLimitDecision(
  entries: readonly { rule: LimitRule; end: number; count: number }[],
  now: number,
): RateLimitDecision {
  const blocked = entries.filter(({ rule, count }) => count >= rule.limit);
  return blocked.length
    ? { allowed: false, retryAfterSeconds: Math.ceil(Math.max(...blocked.map(({ end }) => end - now)) / 1000) }
    : { allowed: true, retryAfterSeconds: 0 };
}
