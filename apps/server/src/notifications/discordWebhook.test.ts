import { randomUUID } from 'node:crypto';
import { createHook } from 'node:async_hooks';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeDiscordWebhookUrl,
  sendDiscordWebhook,
  type DiscordWebhookRequestInit,
  type DiscordWebhookSendResult,
  type DiscordWebhookTransport,
} from './discordWebhook';

// 이 파일의 주소와 표지는 무작위로 만든 시험값이며 실제 웹훅이 아니다.
const token = `transport_${randomUUID().replaceAll('-', '')}_zQxV`;
const url = `https://discord.com/api/webhooks/1/${token}`;
const content = `알림본문_${randomUUID()}`;
const responseMarker = `response_${randomUUID()}`;
const input = { url, content };
type Options = Parameters<typeof sendDiscordWebhook>[1];
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const timeoutCount = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

// 프로세스의 다른 타이머가 시험 도중 끝나더라도 이 호출의 누수는 따로 찾는다.
function timerProbe() {
  const live = new Set<number>();
  let collecting = false;
  let observed = 0;
  const hook = createHook({
    init(id, type) {
      if (collecting && type === 'Timeout') {
        live.add(id);
        observed++;
      }
    },
    destroy(id) {
      live.delete(id);
    },
  }).enable();
  return {
    run<T>(operation: () => T): T {
      collecting = true;
      try {
        return operation();
      } finally {
        collecting = false;
      }
    },
    assertDisposed() {
      expect(observed).toBeGreaterThan(0);
      expect(live.size).toBe(0);
    },
    close() {
      hook.disable();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function assertPrivate(result: DiscordWebhookSendResult) {
  const serialized = JSON.stringify(result);
  for (const secret of [url, token, token.slice(-4), content, responseMarker]) expect(serialized).not.toContain(secret);
  expect(Object.keys(result).sort()).toEqual(
    (result.kind === 'HTTP_OBSERVED' ? ['kind', 'status', 'category', 'retryAfterSeconds'] : ['kind', 'code']).sort(),
  );
}

async function send(value: unknown, options?: Options) {
  const result = await sendDiscordWebhook(value, options);
  assertPrivate(result);
  return result;
}

const consoleMethods = ['log', 'info', 'warn', 'error'] as const;
beforeEach(() => {
  for (const method of consoleMethods) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  try {
    for (const method of consoleMethods) expect(console[method]).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

type Received = { method: string | undefined; path: string | undefined; contentType: string | undefined; body: string };
async function receiver(reply: (request: IncomingMessage, response: ServerResponse) => void) {
  const received: Received[] = [];
  const calls: { url: string; init: DiscordWebhookRequestInit; abortedAtCall: boolean }[] = [];
  const transportFailures: {
    name: string;
    code: string | null;
    aborted: boolean;
    received: number;
    listening: boolean;
    port: number;
  }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        path: request.url,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      reply(request, response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const transport: DiscordWebhookTransport = (endpoint, init) => {
    calls.push({ url: endpoint, init, abortedAtCall: init.signal.aborted });
    // 운영 URL 검사를 우회하지 않고 신뢰된 시험 전송부만 고정 수신기로 보낸다.
    return fetch(`${origin}/hook`, init).catch((error: unknown) => {
      const cause = error instanceof Error && error.cause && typeof error.cause === 'object' ? error.cause : null;
      const code = cause && 'code' in cause ? cause.code : null;
      // 실패 원문·URL·본문은 남기지 않고 시험 수신기의 연결 상태만 진단한다.
      transportFailures.push({
        name: error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : 'unknown',
        code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null,
        aborted: init.signal.aborted,
        received: received.length,
        listening: server.listening,
        port: address.port,
      });
      throw error;
    });
  };
  return {
    origin,
    received,
    calls,
    transportFailures,
    transport,
    async close() {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function assertRequest(local: Awaited<ReturnType<typeof receiver>>) {
  expect(local.received).toEqual([
    {
      method: 'POST',
      path: '/hook',
      contentType: 'application/json',
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    },
  ]);
  expect(local.calls).toHaveLength(1);
  const call = local.calls[0]!;
  expect(call.url).toBe(url);
  expect(call.init.method).toBe('POST');
  expect(call.init.headers).toEqual({ 'content-type': 'application/json' });
  expect(call.init.redirect).toBe('manual');
  expect(call.init.signal).toBeInstanceOf(AbortSignal);
  expect(call.abortedAtCall).toBe(false);
}

describe('입력 검사와 마스킹', () => {
  const invalidUrls = [
    '',
    'http://discord.com/api/webhooks/1/abcde',
    '//discord.com/api/webhooks/1/abcde',
    'https:/discord.com/api/webhooks/1/abcde',
    'https:///discord.com/api/webhooks/1/abcde',
    ...[
      'discord.com:443',
      'discord.com:',
      'user@discord.com',
      '@discord.com',
      'u:p@discord.com',
      'discord.com.',
      'www.discord.com',
      'canary.discord.com',
      'ptb.discord.com',
      'discord.com.evil.test',
      'discord.gg',
      '127.0.0.1',
      '[::1]',
      'localhost',
      'dіscord.com',
      'discord%2ecom',
    ].map((host) => `https://${host}/api/webhooks/1/abcde`),
    ...['/', '/slack', '/github', '?', '?wait=true', '#', '#x', '%20', '\\'].map((suffix) => `${url}${suffix}`),
    ...[
      '/api/v10/webhooks/1/abcde',
      '/API/webhooks/1/abcde',
      '/api/Webhooks/1/abcde',
      '/api/x/../webhooks/1/abcde',
      '/api/./webhooks/1/abcde',
      '/api/webhooks/1/ab%63de',
    ].map((path) => `https://discord.com${path}`),
    ...['0', '00', '01', '18446744073709551616', '123456789012345678901', '-1', '1.0', '1e3', ''].map(
      (id) => `https://discord.com/api/webhooks/${id}/abcde`,
    ),
    ...['abcd', 'a'.repeat(257), 'ab.cd', 'ab~cd', 'ab=cd', 'ab+cd', 'abc한글'].map(
      (value) => `https://discord.com/api/webhooks/1/${value}`,
    ),
    ` ${url}`,
    `${url} `,
    `${url}\n`,
    `${url}\u0000`,
    `${url}\u00a0`,
    `${url}\uff21`,
    url.replace('/api', '\t/api'),
    url.replace('/api', '\\api'),
    'x'.repeat(513),
  ];

  it.each(invalidUrls.map((value, index) => ({ value, index })))('주소 경계 거부 $index', async ({ value }) => {
    const transport = vi.fn<DiscordWebhookTransport>();
    expect(normalizeDiscordWebhookUrl(value)).toBeNull();
    expect(await send({ url: value, content }, { transport })).toEqual({ kind: 'NOT_SENT', code: 'INVALID_URL' });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['https://discord.com/api/webhooks/1/abcde', '1', 'abcde'],
    ['https://discordapp.com/api/webhooks/1/ABcDe', '1', 'ABcDe'],
    ['HTTPS://Discord.COM/api/webhooks/1/a_b-c', '1', 'a_b-c'],
    [
      `https://discordapp.com/api/webhooks/18446744073709551615/${'a'.repeat(256)}`,
      '18446744073709551615',
      'a'.repeat(256),
    ],
  ])('정규화와 마스킹은 전송 경로와 같은 주소 규칙을 쓴다 (%#)', async (value, id, secret) => {
    const normalized = normalizeDiscordWebhookUrl(value)!;
    expect(normalized).toEqual({
      endpoint: `https://discord.com/api/webhooks/${id}/${secret}`,
      last4: secret.slice(-4),
    });
    expect(normalized.last4).not.toBe(secret);
    expect(normalizeDiscordWebhookUrl(value)).not.toBe(normalized);
    const transport = vi.fn<DiscordWebhookTransport>().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await send({ url: value, content }, { transport })).toEqual({
      kind: 'HTTP_OBSERVED',
      status: 204,
      category: 'STATUS_2XX',
      retryAfterSeconds: null,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toBe(normalized.endpoint);
  });

  it.each([undefined, null, 1, new String(url), { url }])(
    '정규화는 원시 문자열만 받고 네트워크를 쓰지 않는다 (%#)',
    (value) => {
      expect(normalizeDiscordWebhookUrl(value)).toBeNull();
    },
  );

  it('틀린 옵션을 먼저 거부하고 getter나 Proxy 예외를 밖으로 보내지 않는다', async () => {
    const getter = vi.fn(() => {
      throw new Error(responseMarker);
    });
    const transport = vi.fn<DiscordWebhookTransport>();
    const invalid = [
      null,
      [],
      'x',
      { transport: 'x' },
      { transport, timeout: 1 },
      { [Symbol()]: transport },
      Object.defineProperty({}, 'transport', { get: getter }),
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error(responseMarker);
          },
        },
      ),
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error(responseMarker);
          },
        },
      ),
      new Proxy(
        { transport },
        {
          getOwnPropertyDescriptor() {
            throw new Error(responseMarker);
          },
        },
      ),
    ];
    for (const options of invalid)
      expect(await send(null, options as Options)).toEqual({ kind: 'NOT_SENT', code: 'INVALID_OPTIONS' });
    expect(getter).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('입력의 모든 자기 키와 값 속성을 검사하고 getter를 실행하지 않는다', async () => {
    const getter = vi.fn(() => {
      throw new Error(responseMarker);
    });
    const transport = vi.fn<DiscordWebhookTransport>();
    const invalid = [
      null,
      [],
      'x',
      new (class {
        url = url;
        content = content;
      })(),
      {},
      { url },
      { content },
      { ...input, embeds: [] },
      { ...input, username: 'x' },
      { ...input, [Symbol()]: 1 },
      Object.defineProperty({ ...input }, 'hidden', { value: 1 }),
      Object.defineProperty({ content }, 'url', { get: getter }),
      Object.defineProperty({ url }, 'content', { set: getter }),
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error(responseMarker);
          },
        },
      ),
      new Proxy(
        { ...input },
        {
          getOwnPropertyDescriptor() {
            throw new Error(responseMarker);
          },
        },
      ),
      { url: new String(url), content },
      { url, content: 1 },
    ];
    for (const value of invalid)
      expect(await send(value, { transport })).toEqual({ kind: 'NOT_SENT', code: 'INVALID_INPUT' });
    expect(getter).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('null prototype 객체와 빈 옵션을 허용하고 결과 객체는 매번 새로 만든다', async () => {
    const value = Object.assign(Object.create(null), input);
    const options = Object.assign(Object.create(null), {
      transport: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    });
    const first = await send(value, options);
    const second = await send(value, options);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    // 빈 옵션과 undefined transport는 기본 전송부를 고르지만 잘못된 주소는 호출 전에 막힌다.
    for (const empty of [{}, { transport: undefined }])
      expect(await send({ url: 'invalid', content }, empty as Options)).toEqual({
        kind: 'NOT_SENT',
        code: 'INVALID_URL',
      });
  });

  it('주소와 내용이 모두 틀리면 주소 실패가 먼저다', async () => {
    const transport = vi.fn<DiscordWebhookTransport>();
    expect(await send({ url: 'invalid', content: ' ' }, { transport })).toEqual({
      kind: 'NOT_SENT',
      code: 'INVALID_URL',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    '',
    ' ',
    '\n\t',
    '\u3000',
    '\u00a0',
    '\ufeff',
    '\uD800',
    'a\uDC00b',
    '\uDC00\uD800',
    'a'.repeat(2001),
    '\u{1F600}'.repeat(1000) + 'a',
    'a'.repeat(1999) + '\u{1F600}',
  ])('잘못된 내용은 전송하지 않는다 (%#)', async (value) => {
    const transport = vi.fn<DiscordWebhookTransport>();
    expect(await send({ url, content: value }, { transport })).toEqual({ kind: 'NOT_SENT', code: 'INVALID_CONTENT' });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    'a'.repeat(2000),
    '\u{1F600}'.repeat(1000),
    ' 앞뒤 공백 ',
    'e\u0301',
    '\u200b',
    '@everyone <@123> <@&456> 확인',
    '\u0001'.repeat(2000),
  ])('정상 내용은 다듬지 않고 멘션을 막는 두 필드만 보낸다 (%#)', async (value) => {
    const transport = vi.fn<DiscordWebhookTransport>().mockResolvedValue(new Response(null, { status: 204 }));
    expect((await send({ url, content: value }, { transport })).kind).toBe('HTTP_OBSERVED');
    expect(transport).toHaveBeenCalledTimes(1);
    const body = transport.mock.calls[0]![1].body;
    expect(JSON.parse(body)).toEqual({ content: value, allowed_mentions: { parse: [] } });
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(16384);
  });
});

describe('전송 결과와 응답 정리', () => {
  it.each(['throw', 'ENOTFOUND', 'ECONNREFUSED', 'AbortError'])(
    '호출 뒤 $0 오류는 내용을 숨기고 UNKNOWN으로 끝난다',
    async (mode) => {
      const before = timeoutCount();
      const error = new TypeError(responseMarker, { cause: { code: mode, private: token } });
      if (mode === 'AbortError') error.name = mode;
      const transport = vi.fn<DiscordWebhookTransport>(() => {
        if (mode === 'throw') throw error;
        return Promise.reject(error);
      });
      expect(await send(input, { transport })).toEqual({ kind: 'UNKNOWN', code: 'TRANSPORT_FAILED' });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(timeoutCount()).toBe(before);
    },
  );

  it.each([{}, { status: 200 }, Response.error()])('Response가 아닌 값이나 status 0을 거부한다 (%#)', async (value) => {
    const before = timeoutCount();
    const transport = vi.fn<DiscordWebhookTransport>().mockResolvedValue(value as Response);
    expect(await send(input, { transport })).toEqual({ kind: 'UNKNOWN', code: 'INVALID_RESPONSE' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(timeoutCount()).toBe(before);
  });

  it.each<[string | null, number | null]>([
    ['0', 0],
    ['1', 1],
    ['1.5', 1.5],
    ['0.250', 0.25],
    ['999999.999', 999999.999],
    [' 1.5 ', 1.5],
    [null, null],
    ['', null],
    ['Wed, 21 Oct 2030 07:28:00 GMT', null],
    ['-1', null],
    ['+1', null],
    ['1e3', null],
    ['01', null],
    ['1.', null],
    ['.5', null],
    ['1.2345', null],
    ['1000000', null],
    ['1, 2', null],
    ['9999999.999', null],
  ])('429 Retry-After만 제한된 숫자로 읽는다 (%#)', async (value, expected) => {
    const before = timeoutCount();
    const headers = new Headers();
    if (value !== null) headers.set('retry-after', value);
    const transport = vi.fn<DiscordWebhookTransport>().mockResolvedValue(new Response(null, { status: 429, headers }));
    expect(await send(input, { transport })).toEqual({
      kind: 'HTTP_OBSERVED',
      status: 429,
      category: 'STATUS_429',
      retryAfterSeconds: expected,
    });
    expect(timeoutCount()).toBe(before);
  });

  it('429가 아니면 헤더도 읽지 않고 본문 메서드는 어느 응답에서도 부르지 않는다', async () => {
    const before = timeoutCount();
    const response = new Response(null, { status: 200 });
    const get = vi.spyOn(response.headers, 'get').mockImplementation(() => {
      throw new Error(responseMarker);
    });
    const readers = ['text', 'json', 'arrayBuffer'] as const;
    const spies = readers.map((method) => vi.spyOn(response, method));
    expect((await send(input, { transport: async () => response })).kind).toBe('HTTP_OBSERVED');
    expect(get).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(timeoutCount()).toBe(before);
  });

  it('본문을 pull하지 않고 cancel 한 번으로 끝내며 정상 경로는 abort하지 않는다', async () => {
    const before = timeoutCount();
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }));
    const transport = vi.fn<DiscordWebhookTransport>().mockResolvedValue(response);
    expect((await send(input, { transport })).kind).toBe('HTTP_OBSERVED');
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1].signal.aborted).toBe(false);
    expect(timeoutCount()).toBe(before);
  });

  it('본문 취소 실패에도 HTTP 관찰을 유지하고 abort한다', async () => {
    const before = timeoutCount();
    const cancel = vi.fn(() => Promise.reject(new Error(responseMarker)));
    const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }));
    const transport = vi.fn<DiscordWebhookTransport>().mockResolvedValue(response);
    expect(await send(input, { transport })).toEqual({
      kind: 'HTTP_OBSERVED',
      status: 200,
      category: 'STATUS_2XX',
      retryAfterSeconds: null,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(timeoutCount()).toBe(before);
  });

  it('abort를 무시하는 전송부도 10초에 끝내고 늦은 resolve와 reject를 정리한다', async () => {
    const before = timeoutCount();
    const probe = timerProbe();
    const rejected: unknown[] = [];
    const onUnhandled = (error: unknown) => rejected.push(error);
    process.on('unhandledRejection', onUnhandled);
    const lateResponse = deferred<Response>();
    const lateError = deferred<Response>();
    const transport = vi
      .fn<DiscordWebhookTransport>()
      .mockReturnValueOnce(lateResponse.promise)
      .mockReturnValueOnce(lateError.promise);
    try {
      const started = performance.now();
      const results = await probe.run(() => Promise.all([send(input, { transport }), send(input, { transport })]));
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(10000);
      expect(elapsed).toBeLessThan(11500);
      expect(results).toEqual([
        { kind: 'UNKNOWN', code: 'TIMEOUT' },
        { kind: 'UNKNOWN', code: 'TIMEOUT' },
      ]);
      expect(transport).toHaveBeenCalledTimes(2);
      for (const [, init] of transport.mock.calls) expect(init.signal.aborted).toBe(true);
      const cancel = vi.fn(() => Promise.reject(new Error(responseMarker)));
      lateResponse.resolve(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })));
      lateError.reject(new Error(responseMarker));
      await nextTurn();
      await nextTurn();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(rejected).toEqual([]);
      expect(results).toEqual([
        { kind: 'UNKNOWN', code: 'TIMEOUT' },
        { kind: 'UNKNOWN', code: 'TIMEOUT' },
      ]);
      probe.assertDisposed();
      expect(timeoutCount()).toBeLessThanOrEqual(before);
    } finally {
      probe.close();
      process.off('unhandledRejection', onUnhandled);
    }
  }, 20000);

  it('끝나지 않는 본문 취소도 같은 10초 제한 안에서 HTTP 관찰로 끝난다', async () => {
    const before = timeoutCount();
    const probe = timerProbe();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let headers: ReturnType<typeof setTimeout> | undefined;
    const transport = vi.fn<DiscordWebhookTransport>(
      () =>
        new Promise((resolve) => {
          headers = setTimeout(() => resolve(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }))), 2000);
        }),
    );
    try {
      const started = performance.now();
      expect(await probe.run(() => send(input, { transport }))).toEqual({
        kind: 'HTTP_OBSERVED',
        status: 200,
        category: 'STATUS_2XX',
        retryAfterSeconds: null,
      });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(10000);
      expect(elapsed).toBeLessThan(11500);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0]![1].signal.aborted).toBe(true);
      await nextTurn();
      probe.assertDisposed();
      expect(timeoutCount()).toBeLessThanOrEqual(before);
    } finally {
      clearTimeout(headers);
      probe.close();
    }
  }, 20000);
});

describe('실제 로컬 HTTP 전송', () => {
  it.each([
    { status: 204, category: 'STATUS_2XX' },
    { status: 200, category: 'STATUS_2XX' },
    { status: 401, category: 'STATUS_401_404' },
    { status: 404, category: 'STATUS_401_404' },
    { status: 429, category: 'STATUS_429', retry: '1.5', seconds: 1.5 },
    { status: 429, category: 'STATUS_429' },
    { status: 429, category: 'STATUS_429', retry: 'Wed, 21 Oct 2030 07:28:00 GMT' },
    { status: 503, category: 'STATUS_5XX', retry: '5' },
    { status: 302, category: 'STATUS_3XX' },
    { status: 307, category: 'STATUS_3XX' },
    { status: 400, category: 'STATUS_4XX_OTHER' },
    { status: 403, category: 'STATUS_4XX_OTHER' },
    { status: 500, category: 'STATUS_5XX' },
  ])('$status 응답을 분류하고 응답 내용은 내보내지 않는다 (%#)', async ({ status, category, retry, seconds }) => {
    const local = await receiver((_request, response) => {
      response.statusCode = status;
      response.statusMessage = responseMarker;
      response.setHeader('x-private', responseMarker);
      response.setHeader('location', `${local.origin}/redirected?${responseMarker}`);
      if (retry !== undefined) response.setHeader('retry-after', retry);
      response.end(status === 204 ? undefined : JSON.stringify({ retry_after: 7, private: responseMarker }));
    });
    try {
      const result = await send(input, { transport: local.transport });
      expect(result, JSON.stringify(local.transportFailures)).toEqual({
        kind: 'HTTP_OBSERVED',
        status,
        category,
        retryAfterSeconds: seconds ?? null,
      });
      await nextTurn();
      assertRequest(local);
      expect(local.calls[0]!.init.signal.aborted).toBe(false);
    } finally {
      await local.close();
    }
  });

  it('본문을 받은 뒤 응답 없이 끊기면 UNKNOWN이고 다시 보내지 않는다', async () => {
    const local = await receiver((request) => request.socket.destroy());
    try {
      expect(await send(input, { transport: local.transport })).toEqual({ kind: 'UNKNOWN', code: 'TRANSPORT_FAILED' });
      await nextTurn();
      assertRequest(local);
    } finally {
      await local.close();
    }
  });

  it('연결 거부도 전송부를 부른 뒤라 UNKNOWN이다', async () => {
    const local = await receiver((_request, response) => response.end());
    try {
      await local.close();
      expect(await send(input, { transport: local.transport })).toEqual({ kind: 'UNKNOWN', code: 'TRANSPORT_FAILED' });
      expect(local.calls).toHaveLength(1);
      expect(local.received).toHaveLength(0);
    } finally {
      await local.close();
    }
  });

  it('헤더 뒤에 멈춘 본문은 취소하고 관찰한 HTTP 상태를 유지한다', async () => {
    const local = await receiver((_request, response) => {
      response.writeHead(200);
      response.write(responseMarker);
    });
    try {
      const started = performance.now();
      expect(await send(input, { transport: local.transport })).toEqual({
        kind: 'HTTP_OBSERVED',
        status: 200,
        category: 'STATUS_2XX',
        retryAfterSeconds: null,
      });
      expect(performance.now() - started).toBeLessThan(11500);
      assertRequest(local);
    } finally {
      await local.close();
    }
  });

  it('loopback 입력을 기본 경로에서도 거부해 수신기에 닿지 않는다', async () => {
    const local = await receiver((_request, response) => response.end());
    try {
      for (const origin of [local.origin, 'https://127.0.0.1'])
        expect(await send({ url: `${origin}/api/webhooks/1/abcde`, content })).toEqual({
          kind: 'NOT_SENT',
          code: 'INVALID_URL',
        });
      expect(local.received).toHaveLength(0);
      expect(local.calls).toHaveLength(0);
    } finally {
      await local.close();
    }
  });

  it('응답이 없으면 실제 10초에 취소하고 TIMEOUT으로 끝난다', async ({ annotate }) => {
    const local = await receiver(() => {});
    let abortedAt: number | undefined;
    const transport: DiscordWebhookTransport = (endpoint, init) => {
      init.signal.addEventListener(
        'abort',
        () => {
          abortedAt = performance.now();
        },
        { once: true },
      );
      return local.transport(endpoint, init);
    };
    try {
      const started = performance.now();
      expect(await send(input, { transport })).toEqual({ kind: 'UNKNOWN', code: 'TIMEOUT' });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(10000);
      expect(elapsed).toBeLessThan(11500);
      expect(abortedAt).toBeDefined();
      expect(abortedAt! - started).toBeGreaterThanOrEqual(10000);
      await annotate(JSON.stringify({ elapsedMs: elapsed, abortElapsedMs: abortedAt! - started }), 'timing');
      assertRequest(local);
      expect(local.calls[0]!.init.signal.aborted).toBe(true);
    } finally {
      await local.close();
    }
  }, 20000);
});
