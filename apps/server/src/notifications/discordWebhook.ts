export type DiscordWebhookRequestInit = Readonly<{
  method: 'POST';
  headers: Readonly<{ 'content-type': 'application/json' }>;
  body: string;
  redirect: 'manual';
  signal: AbortSignal;
}>;
export type DiscordWebhookTransport = (url: string, init: DiscordWebhookRequestInit) => Promise<Response>;

export type DiscordWebhookStatusCategory =
  'STATUS_2XX' | 'STATUS_3XX' | 'STATUS_401_404' | 'STATUS_429' | 'STATUS_4XX_OTHER' | 'STATUS_5XX';

export type DiscordWebhookSendResult =
  | {
      kind: 'NOT_SENT';
      code: 'INVALID_OPTIONS' | 'INVALID_INPUT' | 'INVALID_URL' | 'INVALID_CONTENT' | 'BODY_TOO_LARGE';
    }
  | { kind: 'UNKNOWN'; code: 'TRANSPORT_FAILED' | 'TIMEOUT' | 'INVALID_RESPONSE' }
  | {
      kind: 'HTTP_OBSERVED';
      status: number;
      category: DiscordWebhookStatusCategory;
      retryAfterSeconds: number | null;
    };

export type DiscordWebhookEndpoint = Readonly<{ endpoint: string; last4: string }>;

export function normalizeDiscordWebhookUrl(input: unknown): DiscordWebhookEndpoint | null {
  if (typeof input !== 'string' || input.length > 512 || /[^\x21-\x7e]/.test(input) || /[\\%?#@]/.test(input))
    return null;
  if (!/^https:\/\//i.test(input)) return null;
  const slash = input.indexOf('/', 8);
  const host = input.slice(8, slash).toLowerCase();
  if (host !== 'discord.com' && host !== 'discordapp.com') return null;
  const match = /^\/api\/webhooks\/([1-9][0-9]{0,19})\/([A-Za-z0-9_-]{5,256})$/.exec(input.slice(slash));
  if (!match) return null;
  const id = match[1]!;
  const token = match[2]!;
  if (id.length === 20 && id > '18446744073709551615') return null;
  return { endpoint: `https://discord.com/api/webhooks/${id}/${token}`, last4: token.slice(-4) };
}

function plain(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error();
  return descriptor.value;
}

function wellFormed(content: string): boolean {
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = content.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function category(status: number): DiscordWebhookStatusCategory {
  if (status < 300) return 'STATUS_2XX';
  if (status < 400) return 'STATUS_3XX';
  if (status === 401 || status === 404) return 'STATUS_401_404';
  if (status === 429) return 'STATUS_429';
  return status < 500 ? 'STATUS_4XX_OTHER' : 'STATUS_5XX';
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after');
  return value !== null && value.length <= 10 && /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,3})?$/.test(value)
    ? Number(value)
    : null;
}

function discardLate(value: unknown): void {
  try {
    if (value instanceof Response) void value.body?.cancel().catch(() => {});
  } catch {
    // 결과가 끝난 뒤의 응답 정리 실패는 내보내지 않는다.
  }
}

function sendOnce(
  endpoint: string,
  body: string,
  transport: DiscordWebhookTransport,
): Promise<DiscordWebhookSendResult> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let finished = false;
    let observed: Extract<DiscordWebhookSendResult, { kind: 'HTTP_OBSERVED' }> | undefined;
    const deadline = performance.now() + 10000;
    let timer = setTimeout(expire, 10000);

    function expire(): void {
      if (finished) return;
      const remaining = deadline - performance.now();
      if (remaining > 0) timer = setTimeout(expire, Math.ceil(remaining));
      else finish(observed ?? { kind: 'UNKNOWN', code: 'TIMEOUT' }, true);
    }

    function finish(result: DiscordWebhookSendResult, abort = false): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (abort) controller.abort();
      resolve(result);
    }

    function receive(value: unknown): void {
      if (finished) return discardLate(value);
      try {
        if (
          !(value instanceof Response) ||
          !Number.isInteger(value.status) ||
          value.status < 200 ||
          value.status > 599
        ) {
          finish({ kind: 'UNKNOWN', code: 'INVALID_RESPONSE' }, true);
          discardLate(value);
          return;
        }
        observed = {
          kind: 'HTTP_OBSERVED',
          status: value.status,
          category: category(value.status),
          retryAfterSeconds: null,
        };
        if (value.status === 429) observed.retryAfterSeconds = retryAfter(value);
        const result = observed;
        if (!value.body) return finish(result);
        void Promise.resolve(value.body.cancel()).then(
          () => finish(result),
          () => finish(result, true),
        );
      } catch {
        finish(observed ?? { kind: 'UNKNOWN', code: 'INVALID_RESPONSE' }, true);
      }
    }

    try {
      // 이 호출 뒤의 실패만으로는 요청이 전송됐는지 알 수 없다.
      void Promise.resolve(
        transport(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          redirect: 'manual',
          signal: controller.signal,
        }),
      ).then(receive, () => finish({ kind: 'UNKNOWN', code: 'TRANSPORT_FAILED' }));
    } catch {
      finish({ kind: 'UNKNOWN', code: 'TRANSPORT_FAILED' });
    }
  });
}

export async function sendDiscordWebhook(
  input: unknown,
  options?: { transport?: DiscordWebhookTransport },
): Promise<DiscordWebhookSendResult> {
  let transport: DiscordWebhookTransport;
  try {
    let selected: unknown;
    if (options !== undefined) {
      if (!plain(options)) return { kind: 'NOT_SENT', code: 'INVALID_OPTIONS' };
      const keys = Reflect.ownKeys(options);
      if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'transport'))
        return { kind: 'NOT_SENT', code: 'INVALID_OPTIONS' };
      if (keys.length === 1) selected = dataValue(options, 'transport');
      if (selected !== undefined && typeof selected !== 'function')
        return { kind: 'NOT_SENT', code: 'INVALID_OPTIONS' };
    }
    transport = (selected as DiscordWebhookTransport | undefined) ?? fetch;
  } catch {
    return { kind: 'NOT_SENT', code: 'INVALID_OPTIONS' };
  }
  let url: string;
  let content: string;
  try {
    if (!plain(input)) return { kind: 'NOT_SENT', code: 'INVALID_INPUT' };
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 2 || !keys.includes('url') || !keys.includes('content'))
      return { kind: 'NOT_SENT', code: 'INVALID_INPUT' };
    const rawUrl = dataValue(input, 'url');
    const rawContent = dataValue(input, 'content');
    if (typeof rawUrl !== 'string' || typeof rawContent !== 'string')
      return { kind: 'NOT_SENT', code: 'INVALID_INPUT' };
    url = rawUrl;
    content = rawContent;
  } catch {
    return { kind: 'NOT_SENT', code: 'INVALID_INPUT' };
  }
  const target = normalizeDiscordWebhookUrl(url);
  if (!target) return { kind: 'NOT_SENT', code: 'INVALID_URL' };
  if (content.length < 1 || content.length > 2000 || !content.trim() || !wellFormed(content))
    return { kind: 'NOT_SENT', code: 'INVALID_CONTENT' };
  const body = JSON.stringify({ content, allowed_mentions: { parse: [] } });
  if (Buffer.byteLength(body, 'utf8') > 16384) return { kind: 'NOT_SENT', code: 'BODY_TOO_LARGE' };
  return sendOnce(target.endpoint, body, transport);
}
