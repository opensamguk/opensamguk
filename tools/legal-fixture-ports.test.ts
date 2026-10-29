import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { randomInt } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { listenLegalHttp, listenLegalLoopback } from '../e2e/legalFixturePorts';
import { withLoopbackHttp } from './test-support/loopbackHttp';

afterEach(() => vi.restoreAllMocks());

const errorWith = (code: string) => Object.assign(new Error(`fixture ${code}`), { code });
const bindListeners = (server: Server) => ({
  error: server.listeners('error'),
  listening: server.listeners('listening'),
});
const fastify = createRequire(new URL('../apps/server/package.json', import.meta.url))('fastify') as () => {
  server: Server;
  ready(): Promise<void>;
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
  get(path: string, handler: () => string): void;
};

async function withOwnedListener<T>(
  use: () => Promise<T>,
  close: () => Promise<unknown>,
  listening: () => boolean,
): Promise<T> {
  const errors: unknown[] = [];
  let result!: T;
  try {
    result = await use();
  } catch (error) {
    errors.push(error);
  }
  try {
    await close();
  } catch (error) {
    errors.push(error);
  }
  try {
    expect(listening()).toBe(false);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'owned listener body or cleanup failed');
  return result;
}

it.each(['EADDRINUSE', 'EACCES'])('legal fixture preserves exactly16 Windows %s failures', async (code) => {
  const errors = Array.from({ length: 16 }, () => errorWith(code));
  const listen = vi.fn(async () => {
    throw errors[listen.mock.calls.length - 1];
  });
  const error = await listenLegalLoopback(listen, () => false, { platform: 'win32' }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual(errors);
  expect(listen).toHaveBeenCalledTimes(16);
});

it.each([
  ['linux', 'EACCES'],
  ['darwin', 'EACCES'],
  ['win32', 'EPERM'],
  ['win32', 'EADDRNOTAVAIL'],
] as const)('legal fixture propagates %s %s immediately', async (platform, code) => {
  const original = errorWith(code);
  const listen = vi.fn(async () => {
    throw original;
  });
  await expect(listenLegalLoopback(listen, () => false, { platform })).rejects.toBe(original);
  expect(listen).toHaveBeenCalledTimes(1);
});

it.each(['EADDRINUSE', 'EACCES'])('legal fixture never retries %s after listening', async (code) => {
  const original = errorWith(code);
  const listen = vi.fn(async () => {
    throw original;
  });
  await expect(listenLegalLoopback(listen, () => true, { platform: 'win32' })).rejects.toBe(original);
  expect(listen).toHaveBeenCalledTimes(1);
});

it('raw HTTP binds after an actual occupied candidate, removes bind listeners, and sends once', async () => {
  await withLoopbackHttp(
    (_request, response) => response.end('occupied'),
    async (occupied) => {
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.end('new listener');
      });
      const before = bindListeners(server);
      let first = true;
      await withOwnedListener(
        async () => {
          await listenLegalHttp(server, {
            nextPort: () => {
              if (first) {
                first = false;
                return Number(occupied.port);
              }
              return randomInt(20_000, 50_000);
            },
          });
          const address = server.address();
          expect(address !== null && typeof address !== 'string').toBe(true);
          if (!address || typeof address === 'string') throw new Error('owned address missing');
          expect(String(address.port)).not.toBe(occupied.port);
          expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe('new listener');
          expect(requests).toBe(1);
          expect(bindListeners(server)).toEqual(before);
          expect(await (await fetch(occupied)).text()).toBe('occupied');
        },
        async () => {
          if (server.listening)
            await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
        },
        () => server.listening,
      );
    },
  );
});

it('raw HTTP fails after16 actual occupied binds and leaves no bind listeners or owned listener', async () => {
  await withLoopbackHttp(
    (_request, response) => response.end('occupied'),
    async (occupied) => {
      const server = createServer();
      const before = bindListeners(server);
      const nextPort = vi.fn(() => Number(occupied.port));
      const error = await listenLegalHttp(server, { nextPort }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(16);
      expect((error as AggregateError).errors.every((e) => e.code === 'EADDRINUSE')).toBe(true);
      expect(nextPort).toHaveBeenCalledTimes(16);
      expect(server.listening).toBe(false);
      expect(bindListeners(server)).toEqual(before);
      expect(await (await fetch(occupied)).text()).toBe('occupied');
    },
  );
});

it('raw HTTP removes bind listeners on synchronous invalid-port failure', async () => {
  const server = createServer();
  const before = bindListeners(server);
  const nextPort = vi.fn(() => -1);
  await expect(listenLegalHttp(server, { nextPort })).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' });
  expect(nextPort).toHaveBeenCalledTimes(1);
  expect(server.listening).toBe(false);
  expect(bindListeners(server)).toEqual(before);
});

it('Fastify reuses the prepared instance after an actual collision and handles exactly one HTTP request', async () => {
  await withLoopbackHttp(
    (_request, response) => response.end('occupied'),
    async (occupied) => {
      const api = fastify();
      let requests = 0;
      api.get('/', () => {
        requests++;
        return 'fastify listener';
      });
      let first = true;
      await withOwnedListener(
        async () => {
          await api.ready();
          const origin = await listenLegalLoopback(
            (port) => api.listen({ host: '127.0.0.1', port }),
            () => api.server.listening,
            {
              nextPort: () => {
                if (first) {
                  first = false;
                  return Number(occupied.port);
                }
                return randomInt(20_000, 50_000);
              },
            },
          );
          expect(new URL(origin).port).not.toBe(occupied.port);
          expect(await (await fetch(origin)).text()).toBe('fastify listener');
          expect(requests).toBe(1);
          expect(await (await fetch(occupied)).text()).toBe('occupied');
        },
        () => api.close(),
        () => api.server.listening,
      );
    },
  );
});

it.each(['raw', 'fastify'])(
  'preserves %s body and close failures and still checks the settled listener',
  async (kind) => {
    const bodyError = new Error('owned body failed');
    const closeError = new Error('owned close failed');
    const api = kind === 'fastify' ? fastify() : undefined;
    const socket = api?.server ?? createServer();
    let settledChecks = 0;
    const error = await withOwnedListener(
      async () => {
        if (api) {
          await api.ready();
          await listenLegalLoopback(
            (port) => api.listen({ host: '127.0.0.1', port }),
            () => api.server.listening,
          );
        } else await listenLegalHttp(socket);
        throw bodyError;
      },
      async () => {
        if (api) await api.close();
        else if (socket.listening)
          await new Promise<void>((resolve, reject) => socket.close((e) => (e ? reject(e) : resolve())));
        throw closeError;
      },
      () => {
        settledChecks++;
        return socket.listening;
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([bodyError, closeError]);
    expect(settledChecks).toBe(1);
    expect(socket.listening).toBe(false);
  },
);
