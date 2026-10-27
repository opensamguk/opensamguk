export type TokenEntry = { kind: 'missing' | 'invalid' } | { kind: 'token'; token: string };

export function parseTokenFragment(hash: string): TokenEntry {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!value) return { kind: 'missing' };
  const params = new URLSearchParams(value);
  const tokens = params.getAll('token');
  if (
    tokens.length !== 1 ||
    [...params.keys()].some((key) => key !== 'token') ||
    !/^[A-Za-z0-9_-]{43}$/.test(tokens[0]!)
  )
    return { kind: 'invalid' };
  return { kind: 'token', token: tokens[0]! };
}

// 라우트 진입에서 한 번 읽는다. StrictMode 렌더는 같은 진입 문맥을 사용한다.
export function takeTokenFragment(hash: string, clear = true) {
  const entry = parseTokenFragment(hash);
  const expected = hash.startsWith('#') ? hash.slice(1) : hash;
  if (clear && window.location.hash.slice(1) === expected && expected) {
    // history 인스턴스를 감싼 라우터에 재진입하지 않고 같은 공개 DOM 메서드로 주소만 지운다.
    window.History.prototype.replaceState.call(
      window.history,
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
  }
  return entry;
}
