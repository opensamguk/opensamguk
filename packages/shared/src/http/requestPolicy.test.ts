import { expect, it } from 'vitest';
import { requestGuard, rateLimitWindows, rateLimitDecision } from './requestPolicy';

const origin = 'https://game.example';
const post = { method: 'POST', accept: undefined, origin, secFetchSite: undefined, contentType: 'application/json' };
it('T2-15 AC-M2-08 AC-M3-03 두 adapter가 출처·JSON 판정 순서를 공유한다', () => {
  expect(requestGuard(post, origin)).toBeNull();
  expect(requestGuard({ ...post, contentType: 'Application/JSON; charset=utf-8' }, origin)).toBeNull();
  expect(requestGuard({ ...post, origin: undefined, secFetchSite: 'same-origin' }, origin)).toBeNull();
  for (const secFetchSite of [undefined, 'none', 'cross-site'])
    expect(requestGuard({ ...post, origin: undefined, secFetchSite }, origin)?.status).toBe(403);
  expect(
    requestGuard(
      { ...post, origin: 'https://other.example', secFetchSite: 'same-origin', contentType: 'text/plain' },
      origin,
    )?.status,
  ).toBe(403);
  expect(requestGuard({ ...post, contentType: 'text/plain' }, origin)?.status).toBe(415);
  expect(requestGuard({ ...post, method: 'GET', origin: undefined }, origin)).toBeNull();
  expect(
    requestGuard(
      {
        ...post,
        method: 'GET',
        accept: 'application/json, Text/Event-Stream; charset=utf-8',
        origin: 'https://other.example',
      },
      origin,
    )?.status,
  ).toBe(403);
});

it('epoch 창 경계와 가장 긴 Retry-After를 저장소 없이 계산한다', () => {
  const rule = { namespace: 'login', key: 'ip', limit: 1, windowMs: 60_000 };
  const entries = rateLimitWindows([rule, { ...rule, windowMs: 3_600_000 }], 59_999);
  expect(entries[0]!.end).toBe(60_000);
  expect(
    rateLimitDecision(
      entries.map((entry) => ({ ...entry, count: 1 })),
      59_999,
    ),
  ).toEqual({ allowed: false, retryAfterSeconds: 3541 });
  expect(rateLimitWindows([rule], 60_000)[0]!.end).toBe(120_000);
  expect(() => rateLimitWindows([{ ...rule, limit: 0 }], 0)).toThrow();
});
