// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { parseTokenFragment, takeTokenFragment } from './tokenEntry';

const secret = 'a'.repeat(43);
afterEach(() => {
  vi.restoreAllMocks();
  window.History.prototype.replaceState.call(window.history, null, '', '/');
});
it.each(['', '#'])('조각 없는 %s 진입을 구분한다', (hash) => {
  expect(parseTokenFragment(hash)).toEqual({ kind: 'missing' });
});
it.each([
  'token=short',
  'other=x',
  `token=${secret}&token=${secret}`,
  `token=${secret}&other=x`,
  'token=%zz',
  'token=' + 'a'.repeat(44),
])('잘못된 토큰 조각을 거부한다(%#)', (hash) => {
  expect(parseTokenFragment(hash).kind).toBe('invalid');
});
it('브라우저 주소만 지우며 history 래퍼·재진입을 부르지 않는다', () => {
  window.history.replaceState({ retained: true }, '', '/reset-password?from=mail#token=' + secret);
  const wrapped = vi.spyOn(window.history, 'replaceState');
  const entry = takeTokenFragment(window.location.hash);
  expect(entry.kind === 'token' && entry.token === secret).toBe(true);
  expect(window.location.pathname + window.location.search).toBe('/reset-password?from=mail');
  expect(window.location.hash).toBe('');
  expect(window.history.state).toEqual({ retained: true });
  expect(wrapped.mock.calls.length).toBe(0);
});
it('미리 읽기와 다른 화면의 조각은 지우지 않는다', () => {
  window.history.replaceState(null, '', '/verify-email#token=' + secret);
  expect(takeTokenFragment('token=' + secret, false).kind).toBe('token');
  expect(Boolean(window.location.hash)).toBe(true);
  takeTokenFragment('other=anchor');
  expect(Boolean(window.location.hash)).toBe(true);
});
