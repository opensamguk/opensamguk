import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { expect, it } from 'vitest';
import { sendUptimeNotice } from './uptimeWebhook';

const notice = {
  id: 'prod:down:2.1',
  kind: 'down' as const,
  decidedRunId: '2',
  decidedAt: '2026-10-29T00:00:00.000Z',
  attempts: 0,
  lastAttemptAt: null,
};
async function withServer<T>(handler: RequestListener, use: (endpoint: URL) => Promise<T>) {
  const server = createServer(handler);
  for (let index = 0; index < 16; index++) {
    try {
      server.listen(randomInt(10081, 65536), '127.0.0.1');
      await once(server, 'listening');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Own receiver bind failed');
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    result = await use(new URL(`http://127.0.0.1:${address.port}/receiver`));
  } catch (error) {
    failures.push(error);
  }
  try {
    const close = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    server.closeAllConnections();
    await close;
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, 'Receiver body or cleanup failed');
  return result!;
}

it.each([200, 204, 302, 429, 500])(
  'T3-11 AC-M3-09 실제 웹훅 %i와 고정 wait/JSON·원문 비노출을 확인한다',
  async (status) => {
    let hits = 0;
    const requests: {
      path: string | undefined;
      method: string | undefined;
      type: string | undefined;
      privateHeaders: unknown[];
      body: string;
    }[] = [];
    await withServer(
      (request, response) => {
        hits++;
        let body = '';
        request.on('data', (chunk) => (body += String(chunk)));
        request.on('end', () => {
          requests.push({
            path: request.url,
            method: request.method,
            type: request.headers['content-type'],
            privateHeaders: [request.headers.cookie, request.headers.authorization, request.headers.origin],
            body,
          });
          response.writeHead(status, { location: '/must-not-follow' });
          response.end('receiver-private-canary');
        });
      },
      async (endpoint) => {
        const original = endpoint.href;
        const result = await sendUptimeNotice({ endpoint, notice, timeoutMs: 1000 });
        expect(result).toEqual({ outcome: status < 300 ? 'ok' : status < 400 ? 'redirect' : 'status', status });
        expect(JSON.stringify(result).includes('receiver-private-canary')).toBe(false);
        expect(endpoint.href === original).toBe(true);
        expect(hits).toBe(1);
        expect(requests).toHaveLength(1);
        const row = requests[0]!;
        expect(row.path).toBe('/receiver?wait=true');
        expect(row.method).toBe('POST');
        expect(row.type).toBe('application/json');
        expect(row.privateHeaders).toEqual([undefined, undefined, undefined]);
        expect(JSON.parse(row.body)).toEqual({
          content: `opensamguk 장애\n${notice.id}\n${notice.decidedAt}`,
          allowed_mentions: { parse: [] },
        });
      },
    );
  },
);

it('T3-11 AC-M3-09 실제 timeout·연결 거부와 잘못된 제한의 무전송을 구분한다', async () => {
  let hits = 0;
  const endpoint = await withServer(
    () => {
      hits++;
    },
    async (endpoint) => {
      for (const timeoutMs of [0, 10001, 1.5])
        await expect(sendUptimeNotice({ endpoint, notice, timeoutMs })).rejects.toThrow('invalid_timeout');
      expect(hits).toBe(0);
      expect(await sendUptimeNotice({ endpoint, notice, timeoutMs: 100 })).toEqual({ outcome: 'timeout' });
      expect(hits).toBe(1);
      return endpoint;
    },
  );
  expect(await sendUptimeNotice({ endpoint, notice, timeoutMs: 1000 })).toEqual({ outcome: 'network' });
}, 5000);
