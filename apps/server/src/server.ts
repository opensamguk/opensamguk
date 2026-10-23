import { publicMapConfig } from '@opensamguk/shared';
import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { PrismaClient } from '@opensamguk/db';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import fastify, { type FastifyRequest } from 'fastify';
import pino, { type DestinationStream } from 'pino';
import { authenticate, SESSION_SECONDS } from './auth/session';
import { hashPassword } from './auth/password';
import { appRouter, type AppRouter } from './router';
import { createRateLimiter } from './security/rateLimit';

export async function buildServer(options: {
  db: PrismaClient;
  now?: () => number;
  secureCookies?: boolean;
  logging?: boolean;
  logStream?: DestinationStream;
  publicOrigin?: string;
  production?: boolean;
  trustProxy?: boolean;
}) {
  const mapConfig = publicMapConfig(process.env);
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const secureCookies = options.secureCookies ?? production;
  if (production && !secureCookies) throw new Error('운영 세션 쿠키에는 Secure가 필요합니다.');
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? (production ? '' : 'http://127.0.0.1:5173');
  let originUrl: URL;
  try {
    originUrl = new URL(publicOrigin);
  } catch {
    throw new Error('PUBLIC_ORIGIN에 화면의 출처를 지정하세요.');
  }
  if (
    originUrl.origin !== publicOrigin ||
    !['http:', 'https:'].includes(originUrl.protocol) ||
    (production && originUrl.protocol !== 'https:')
  )
    throw new Error('PUBLIC_ORIGIN에 화면의 출처를 지정하세요.');
  const trustProxyValue = process.env.TRUST_PROXY;
  if (trustProxyValue !== undefined && trustProxyValue !== '0' && trustProxyValue !== '1')
    throw new Error('TRUST_PROXY는 0 또는 1이어야 합니다.');
  const clock = options.now ?? Date.now;
  const rateLimiter = createRateLimiter({ now: clock });
  const requestTimes = new WeakMap<FastifyRequest, number>();
  const log = pino(
    {
      serializers: {
        req: (request: { id?: string; method?: string }) => ({ id: request.id, method: request.method }),
        res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
        err: () => ({ message: '요청 실패' }),
      },
      redact: ['req.headers.cookie', 'res.headers["set-cookie"]', 'password', 'token'],
    },
    options.logStream,
  );
  const server = fastify({
    trustProxy: (options.trustProxy ?? trustProxyValue === '1') ? (_address: string, hop: number) => hop === 0 : false,
    routerOptions: { maxParamLength: 5000 },
    ...(options.logging === false ? { logger: false } : { loggerInstance: log }),
  });
  server.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    const path = req.routeOptions.url ?? req.url.split('?')[0]!;
    if (path !== '/trpc' && !path.startsWith('/trpc/')) return;
    const sse = req.headers.accept
      ?.split(',')
      .some((value) => value.split(';')[0]?.trim().toLowerCase() === 'text/event-stream');
    if (req.method !== 'POST' && !sse) return;
    const origin = req.headers.origin;
    if (origin !== undefined ? origin !== publicOrigin : req.headers['sec-fetch-site'] !== 'same-origin')
      return reply.code(403).send({ error: '같은 출처에서 요청하세요.' });
    if (
      req.method === 'POST' &&
      req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
    )
      return reply.code(415).send({ error: 'JSON 본문이 필요합니다.' });
  });
  await server.register(cookie);
  server.addHook('onSend', async (req, reply, payload) => {
    const now = requestTimes.get(req);
    // tRPC가 보낸 Web Response의 status는 Fastify가 onSend 뒤에 reply로 옮긴다.
    const status = payload instanceof Response ? payload.status : reply.statusCode;
    // 거부한 요청은 세션 만료 시각도 바꾸지 않는다. 성공 응답에서만 기존 갱신 계약을 적용한다.
    if (status === 200 && now !== undefined && req.cookies.sid) {
      try {
        const identity = await authenticate(options.db, req.cookies.sid, now);
        if (identity?.renewed)
          reply.setCookie('sid', req.cookies.sid, {
            httpOnly: true,
            sameSite: 'lax',
            secure: secureCookies,
            path: '/',
            maxAge: SESSION_SECONDS,
          });
      } catch {
        // 선택적 갱신 실패로 이미 처리한 요청의 성공 응답을 바꾸지 않는다.
        server.log.warn('세션 갱신 실패');
      }
    }
    return payload;
  });
  const dummyPasswordHash = await hashPassword(randomBytes(32).toString('hex'));

  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      async createContext({ req, res }) {
        const now = clock();
        requestTimes.set(req, now);
        const identity = await authenticate(options.db, req.cookies.sid, now, false);
        return {
          db: options.db,
          publicMapConfig: mapConfig,
          reply: res,
          now,
          user: identity?.user ?? null,
          sessionId: identity?.sessionId ?? null,
          secureCookies,
          dummyPasswordHash,
          ip: req.ip,
          rateLimiter,
        };
      },
      onError({ error }) {
        server.log.error({ code: error.code }, 'tRPC 요청 실패');
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });
  server.setErrorHandler((error, _req, reply) => {
    server.log.warn({ code: 'INVALID_REQUEST' }, '요청 처리 실패');
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    reply.code(status).send({ error: '요청을 처리하지 못했습니다.' });
  });
  return server;
}
