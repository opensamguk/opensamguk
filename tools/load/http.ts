import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { AppRouter } from '../../apps/server/src/router';

type Procedures = {
  'general.create': AppRouter['general']['create'];
  'general.mine': AppRouter['general']['mine'];
  'home.get': AppRouter['home']['get'];
  'world.summary': AppRouter['world']['summary'];
  'world.map': AppRouter['world']['map'];
  'world.list': AppRouter['world']['list'];
  'city.get': AppRouter['city']['get'];
  'nation.get': AppRouter['nation']['get'];
  'turns.get': AppRouter['turns']['get'];
  'turns.set': AppRouter['turns']['set'];
  'message.list': AppRouter['message']['list'];
  'message.send': AppRouter['message']['send'];
  'ranking.generals': AppRouter['ranking']['generals'];
  'ranking.nations': AppRouter['ranking']['nations'];
};
export type LoadProcedure = keyof Procedures;
export type LoadInput<P extends LoadProcedure> = Procedures[P]['_def']['$types']['input'];
export type LoadOutput<P extends LoadProcedure> = Procedures[P]['_def']['$types']['output'];
const mutations: ReadonlySet<LoadProcedure> = new Set(['general.create', 'turns.set', 'message.send']);
const envelope = z.object({ result: z.object({ data: z.unknown() }).optional(), error: z.unknown().optional() });

export function loadOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('LOAD_ORIGIN_INVALID');
  }
  if (
    url.origin !== value ||
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', 'server'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error('LOAD_LOCAL_ORIGIN_REQUIRED');
  return url.origin;
}

export class LoadHttpError extends Error {
  constructor(
    readonly procedure: LoadProcedure,
    readonly status: number,
    readonly durationMs = 0,
  ) {
    super('LOAD_HTTP_REQUEST_FAILED');
  }
}

// Cookie와 응답 본문을 원자료로 직렬화하지 않는다.
export class LoadHttpClient {
  readonly #cookie: string;
  readonly #target: string;
  readonly #origin: string;
  constructor(target: string, origin: string, token: string) {
    this.#target = loadOrigin(target);
    this.#origin = loadOrigin(origin);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('LOAD_SESSION_INVALID');
    this.#cookie = `sid=${token}`;
  }

  toJSON() {
    return { kind: 'load-http-client', credentials: 'omitted' };
  }

  async request<P extends LoadProcedure>(path: P, input: LoadInput<P>, signal: AbortSignal) {
    const mutation = mutations.has(path);
    const body = JSON.stringify(input);
    const query = mutation || input === undefined ? '' : `?input=${encodeURIComponent(body)}`;
    const startedAt = performance.now();
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.#target}/trpc/${path}${query}`, {
        method: mutation ? 'POST' : 'GET',
        headers: {
          origin: this.#origin,
          cookie: this.#cookie,
          ...(mutation ? { 'content-type': 'application/json' } : {}),
        },
        ...(mutation ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      text = await response.text();
    } catch {
      throw new LoadHttpError(path, 0, performance.now() - startedAt);
    }
    const durationMs = performance.now() - startedAt;
    let parsed: z.infer<typeof envelope>;
    try {
      parsed = envelope.parse(JSON.parse(text));
    } catch {
      throw new LoadHttpError(path, response.status, durationMs);
    }
    if (!response.ok || parsed.error || !parsed.result || !Object.hasOwn(parsed.result, 'data'))
      throw new LoadHttpError(path, response.status, durationMs);
    return { data: parsed.result.data as LoadOutput<P>, status: response.status, durationMs };
  }

  async openSse(worldId: string, signal: AbortSignal): Promise<Response> {
    if (!z.uuid().safeParse(worldId).success) throw new Error('LOAD_SSE_WORLD_INVALID');
    let response: Response;
    try {
      response = await fetch(`${this.#target}/sse?worldId=${encodeURIComponent(worldId)}`, {
        headers: { origin: this.#origin, cookie: this.#cookie, accept: 'text/event-stream' },
        redirect: 'error',
        signal,
      });
    } catch {
      throw new Error('LOAD_SSE_CONNECTION_FAILED');
    }
    if (
      response.status !== 200 ||
      !response.headers.get('content-type')?.startsWith('text/event-stream') ||
      !response.body
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('LOAD_SSE_CONNECTION_FAILED');
    }
    return response;
  }
}
