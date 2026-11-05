import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { proxyLegalRequest } from '../e2e/legalFixtureProxy';
import { listenLegalHttp } from '../e2e/legalFixturePorts';

async function listen(server: Server) {
  await listenLegalHttp(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('자기 HTTP 포트가 필요합니다.');
  return 'http://127.0.0.1:' + address.port;
}
const close = (server: Server) =>
  new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

const fastify = createRequire(new URL('../apps/server/package.json', import.meta.url))('fastify') as () => {
  server: Server;
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
  get(
    path: string,
    handler: (request: { raw: IncomingMessage }, reply: { raw: ServerResponse; hijack(): void }) => void,
  ): void;
};

async function fixture(fastifySse = false) {
  const sockets = new Set<Socket>();
  let stream: ServerResponse | undefined;
  const seen: Array<{ method: string | undefined; origin: string | undefined; bytes: number }> = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/sse') {
      stream = response;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: ready\ndata: {}\n\n');
    } else if (request.url === '/echo?part=1') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      seen.push({ method: request.method, origin: request.headers.origin, bytes: Buffer.concat(chunks).length });
      response.writeHead(201, {
        'content-type': 'application/json',
        'set-cookie': ['first=1; HttpOnly', 'second=2; HttpOnly'],
      });
      response.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), cookie: request.headers.cookie }));
    } else response.destroy();
  };
  const app = fastifySse ? fastify() : undefined;
  const backend = app?.server ?? createServer(handle);
  app?.get('/sse', (request, reply) => {
    reply.hijack();
    void handle(request.raw, reply.raw);
  });
  backend.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const backendOrigin = app ? await app.listen({ host: '127.0.0.1', port: 0 }) : await listen(backend);
  const closeBackend = () => (app ? app.close() : close(backend));
  const jobs = new Set<Promise<void>>();
  const front = createServer((request, response) => {
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    const work = (async () => {
      try {
        await proxyLegalRequest(backendOrigin + request.url, request, response, controller.signal);
      } catch {
        if (!response.destroyed) {
          if (!response.headersSent) response.statusCode = 502;
          response.end('시험 서비스 요청 실패');
        }
      }
    })();
    jobs.add(work);
    void work.finally(() => jobs.delete(work));
  });
  const origin = await listen(front);
  let frontClosed = false;
  async function closeFront() {
    if (frontClosed) return;
    frontClosed = true;
    const closing = close(front);
    front.closeAllConnections();
    await closing;
    await Promise.all([...jobs]);
  }
  return {
    origin,
    seen,
    closeBackend,
    dropStream: () => stream?.destroy(),
    backend,
    sockets,
    closeFront,
    async cleanup() {
      await closeFront();
      for (const socket of sockets) socket.destroy();
      if (backend.listening) await closeBackend();
    },
  };
}

describe('T2-09 AC-M2-07 실제 HTTP 중계 종료', () => {
  it('SSE 취소 후 요청 없는 상류 소켓을 남기지 않아 API가 강제 종료 없이 닫힌다', async () => {
    const own = await fixture(true);
    const controller = new AbortController();
    let backendClosing: Promise<void> | undefined;
    try {
      const response = await fetch(own.origin + '/sse', { signal: controller.signal });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await own.closeFront();
      await delay(100);
      backendClosing = own.closeBackend();
      const closed = await Promise.race([backendClosing.then(() => true), delay(1000).then(() => false)]);
      expect({ closed, unusedSockets: [...own.sockets].filter((socket) => socket.bytesRead === 0).length }).toEqual({
        closed: true,
        unusedSockets: 0,
      });
    } finally {
      controller.abort();
      await own.cleanup();
      await backendClosing;
    }
  });
  it('POST 본문·쿠키·쿼리·상태와 복수 Set-Cookie를 보존한다', async () => {
    const own = await fixture();
    try {
      const body = JSON.stringify({ name: '장수𠀀', revision: 3 });
      const response = await fetch(own.origin + '/echo?part=1', {
        method: 'POST',
        headers: { cookie: 'sid=test-session', origin: 'https://owned.example.test' },
        body,
      });
      expect(response.status).toBe(201);
      expect(response.headers.getSetCookie()).toEqual(['first=1; HttpOnly', 'second=2; HttpOnly']);
      expect(await response.json()).toEqual({ body, cookie: 'sid=test-session' });
      expect(own.seen).toEqual([
        { method: 'POST', origin: 'https://owned.example.test', bytes: Buffer.byteLength(body) },
      ]);
    } finally {
      await own.cleanup();
    }
  });
  it.each([1_048_576, 1_048_577])('요청 %i바이트의 기존 한도를 상류 전송 전에 적용한다', async (bytes) => {
    const own = await fixture();
    try {
      const response = await fetch(own.origin + '/echo?part=1', { method: 'POST', body: 'x'.repeat(bytes) });
      expect(response.status).toBe(bytes === 1_048_576 ? 201 : 413);
      if (response.status === 201) {
        expect(own.seen[0]?.bytes).toBe(bytes);
        const data = (await response.json()) as { body: string };
        expect(Buffer.byteLength(data.body)).toBe(bytes);
      } else {
        expect(await response.text()).toBe('');
        expect(own.seen).toEqual([]);
      }
    } finally {
      await own.cleanup();
    }
  });
  it.each(['GET', 'HEAD'])('%s 요청은 상류에 본문을 추가하지 않는다', async (method) => {
    const own = await fixture();
    try {
      const response = await fetch(own.origin + '/echo?part=1', { method });
      expect(response.status).toBe(201);
      if (method === 'HEAD') expect(await response.text()).toBe('');
      else expect(await response.json()).toEqual({ body: '' });
      expect(own.seen).toEqual([{ method, origin: undefined, bytes: 0 }]);
    } finally {
      await own.cleanup();
    }
  });
  it('헤더 뒤 상류가 끊기면 스트림을 종료하고 오류 본문을 덧붙이지 않는다', async () => {
    const own = await fixture();
    try {
      const response = await fetch(own.origin + '/sse');
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
      const next = reader.read();
      own.dropStream();
      await expect(next).rejects.toThrow();
      await reader.cancel().catch(() => undefined);
    } finally {
      await own.cleanup();
    }
  });
  it('상류 연결 실패는 응답이 시작되기 전에 호출자에게 전달한다', async () => {
    const own = await fixture();
    try {
      const response = await fetch(own.origin + '/disconnect');
      expect(response.status).toBe(502);
      expect(await response.text()).toBe('시험 서비스 요청 실패');
    } finally {
      await own.cleanup();
    }
  });
});
