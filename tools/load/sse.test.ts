import { describe, expect, it } from 'vitest';
import { expectedOwnedAbort, LoadSseParser, settleLoadSseReader } from './sse';

describe('L3 실제 SSE 프레임 해석', () => {
  const bytes = (value: string) => new TextEncoder().encode(value);
  it('분할된ready프레임과CRLF를확인한다', () => {
    const parser = new LoadSseParser();
    parser.feed(bytes('event: rea'));
    expect(parser.ready).toBe(false);
    parser.feed(bytes('dy\r\ndata: {"kind":"ready"}\r\n\r\n'));
    expect(parser.ready).toBe(true);
  });
  it('heartbeat나일반메시지를ready로세지않는다', () => {
    const parser = new LoadSseParser();
    parser.feed(bytes(': heartbeat\n\nevent: message.new\ndata: {"kind":"ready"}\n\n'));
    expect(parser.ready).toBe(false);
  });
  it('잘못된ready와과대프레임은고정오류로거부한다', () => {
    const parser = new LoadSseParser();
    expect(() => parser.feed(bytes('event: ready\ndata: secret-canary\n\n'))).toThrow('LOAD_SSE_READY_INVALID');
    expect(() => new LoadSseParser().feed(bytes('x'.repeat(65537)))).toThrow('LOAD_SSE_FRAME_TOO_LARGE');
  });
});

describe('L3 SSE 종료 오류 보존', () => {
  it('일반종료의비Abort취소오류를숨기거나종료확정하지않는다', async () => {
    const owned = new AbortController();
    owned.abort();
    const closed = await settleLoadSseReader(
      {
        cancel: async () => {
          throw new Error('private-cancel-canary');
        },
        closed: Promise.resolve(),
        releaseLock: () => {},
      },
      owned.signal,
      true,
    );
    expect(closed).toBe(false);
  });
  it('자기취소신호의AbortError만정상종료조건으로허용한다', async () => {
    const owned = new AbortController();
    owned.abort();
    const error = new DOMException('owned cancellation', 'AbortError');
    expect(
      await settleLoadSseReader(
        {
          cancel: async () => {
            throw error;
          },
          closed: Promise.reject(error),
          releaseLock: () => {},
        },
        owned.signal,
        true,
      ),
    ).toBe(true);
    expect(expectedOwnedAbort(error, owned.signal, false)).toBe(false);
    expect(expectedOwnedAbort(new Error('other'), owned.signal, true)).toBe(false);
  });
  it('스트림closed·releaseLock오류도종료확정으로바꾸지않는다', async () => {
    const signal = new AbortController().signal;
    expect(
      await settleLoadSseReader(
        { cancel: async () => {}, closed: Promise.reject(new Error('closed fault')), releaseLock: () => {} },
        signal,
        false,
      ),
    ).toBe(false);
    expect(
      await settleLoadSseReader(
        {
          cancel: async () => {},
          closed: Promise.resolve(),
          releaseLock: () => {
            throw new Error('release fault');
          },
        },
        signal,
        false,
      ),
    ).toBe(false);
  });
});
