import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { PrismaClient } from '@opensamguk/db';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import fastify from 'fastify';
import pino, { type DestinationStream } from 'pino';
import { authenticate, SESSION_SECONDS } from './auth/session';
import { hashPassword } from './auth/password';
import { appRouter, type AppRouter } from './router';

export async function buildServer(options: {
  db: PrismaClient; now?: () => number; secureCookies?: boolean; logging?: boolean; logStream?: DestinationStream;
}) {
  const log = pino({ serializers: {
    req: (request: { id?: string; method?: string }) => ({ id: request.id, method: request.method }),
    res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
    err: () => ({ message: '요청 실패' }),
  }, redact: ['req.headers.cookie', 'res.headers["set-cookie"]', 'password', 'token'] }, options.logStream);
  const server = fastify({ routerOptions: { maxParamLength: 5000 },
    ...(options.logging === false ? { logger: false } : { loggerInstance: log }) });
  await server.register(cookie);
  const dummyPasswordHash = await hashPassword(randomBytes(32).toString('hex'));
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production';
  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc', trpcOptions: {
      router: appRouter,
      async createContext({ req, res }) {
        const now = (options.now ?? Date.now)();
        const identity = await authenticate(options.db, req.cookies.sid, now);
        if (identity && req.cookies.sid) res.setCookie('sid', req.cookies.sid,
          { httpOnly: true, sameSite: 'lax', secure: secureCookies, path: '/', maxAge: SESSION_SECONDS });
        return { db: options.db, reply: res, now, user: identity?.user ?? null,
          sessionId: identity?.sessionId ?? null, secureCookies, dummyPasswordHash };
      },
      onError({ error }) { server.log.error({ code: error.code }, 'tRPC 요청 실패'); },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });
  server.setErrorHandler((error, _req, reply) => {
    server.log.warn({ code: 'INVALID_REQUEST' }, '요청 처리 실패');
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    reply.code(status).send({ error: '요청을 처리하지 못했습니다.' });
  });
  return server;
}
