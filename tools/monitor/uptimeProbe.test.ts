import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { describe, expect, it } from 'vitest';
import { probeHealth } from './uptimeProbe';

const PATHS = ['/healthz', '/healthz/engine'] as const;
const TIMEOUT_MS = 1000;

async function withServer<T>(handler: RequestListener, use: (baseUrl: URL) => Promise<T>): Promise<T> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('loopback address missing');
  try {
    return await use(new URL(`http://127.0.0.1:${address.port}`));
  } finally {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  }
}

describe('T3-11 uptime HTTP adapter, not operational acceptance', () => {
  it('uses only the origin and requests both fixed paths without credentials or ambient headers', async () => {
    const requests: { path: string | undefined; method: string | undefined; privateHeaders: unknown[] }[] = [];
    await withServer(
      (request, response) => {
        requests.push({
          path: request.url,
          method: request.method,
          privateHeaders: [request.headers.cookie, request.headers.origin, request.headers.authorization],
        });
        response.end('not part of the result');
      },
      async (baseUrl) => {
        baseUrl.pathname = '/ignored/path';
        baseUrl.search = '?ignored=query';
        baseUrl.hash = '#ignored';
        baseUrl.username = 'ignored-user';
        baseUrl.password = 'ignored-password';
        const original = baseUrl.href;
        expect(await probeHealth({ baseUrl, timeoutMs: TIMEOUT_MS })).toEqual({
          ok: true,
          targets: PATHS.map((path) => ({ path, outcome: 'ok', status: 200 })),
        });
        expect(baseUrl.href).toBe(original);
        expect(requests.sort((a, b) => a.path!.localeCompare(b.path!))).toEqual(
          PATHS.map((path) => ({ path, method: 'GET', privateHeaders: [undefined, undefined, undefined] })),
        );
      },
    );
  });

  it.each([
    ['/healthz', 503],
    ['/healthz/engine', 503],
    ['/healthz/engine', 500],
    ['/healthz/engine', 204],
  ] as const)('reports %s status %i without accepting another 2xx', async (badPath, badStatus) => {
    await withServer(
      (request, response) => {
        response.statusCode = request.url === badPath ? badStatus : 200;
        response.end();
      },
      async (baseUrl) => {
        expect(await probeHealth({ baseUrl, timeoutMs: TIMEOUT_MS })).toEqual({
          ok: false,
          targets: PATHS.map((path) => ({
            path,
            outcome: path === badPath ? 'status' : 'ok',
            status: path === badPath ? badStatus : 200,
          })),
        });
      },
    );
  });

  it('does not follow redirects to another loopback server', async () => {
    let redirectedRequests = 0;
    await withServer(
      (_request, response) => {
        redirectedRequests++;
        response.end();
      },
      async (destination) => {
        await withServer(
          (_request, response) => {
            response.writeHead(302, { location: destination.href });
            response.end();
          },
          async (baseUrl) => {
            expect(await probeHealth({ baseUrl, timeoutMs: TIMEOUT_MS })).toEqual({
              ok: false,
              targets: PATHS.map((path) => ({ path, outcome: 'redirect', status: 302 })),
            });
            expect(redirectedRequests).toBe(0);
          },
        );
      },
    );
  });

  it('times out a silent endpoint, closes its request, and retains the other result', async () => {
    let markClosed!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const requests: string[] = [];
    await withServer(
      (request, response) => {
        requests.push(request.url!);
        if (request.url === '/healthz') response.once('close', markClosed);
        else response.end();
      },
      async (baseUrl) => {
        expect(await probeHealth({ baseUrl, timeoutMs: TIMEOUT_MS })).toEqual({
          ok: false,
          targets: [
            { path: '/healthz', outcome: 'timeout' },
            { path: '/healthz/engine', outcome: 'ok', status: 200 },
          ],
        });
        expect(requests.sort()).toEqual([...PATHS]);
        await cancelled;
      },
    );
  });

  it.each([200, 503])('uses status %i and cancels unfinished bodies without exposing payloads', async (status) => {
    const cancellations: Promise<unknown>[] = [];
    await withServer(
      (_request, response) => {
        cancellations.push(once(response, 'close'));
        response.writeHead(status, { 'content-type': 'text/plain', 'x-private-fixture': 'fixture-header' });
        response.flushHeaders();
        response.write('fixture-body-not-for-output');
      },
      async (baseUrl) => {
        const result = await probeHealth({ baseUrl, timeoutMs: TIMEOUT_MS });
        expect(result).toEqual({
          ok: status === 200,
          targets: PATHS.map((path) => ({ path, outcome: status === 200 ? 'ok' : 'status', status })),
        });
        expect(cancellations).toHaveLength(2);
        await Promise.all(cancellations);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('fixture-body-not-for-output');
        expect(serialized).not.toContain('fixture-header');
        expect(serialized).not.toContain(baseUrl.origin);
      },
    );
  });

  it('reports connection refusal without exposing its address or error message', async () => {
    const baseUrl = await withServer(
      (_request, response) => response.end(),
      async (url) => url,
    );
    expect(await probeHealth({ baseUrl, timeoutMs: TIMEOUT_MS })).toEqual({
      ok: false,
      targets: PATHS.map((path) => ({ path, outcome: 'network' })),
    });
  });
});
