import { createDb } from '@opensamguk/db';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import fastify from 'fastify';
import { appRouter, type AppRouter } from './router';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL이 없습니다. .env.example을 .env로 복사하세요.');
  process.exit(1);
}

const db = createDb(databaseUrl);
const port = Number(process.env.SERVER_PORT ?? 3001);

// httpBatchLink는 여러 procedure 이름을 경로에 담으므로 maxParamLength를 늘린다.
const server = fastify({ logger: true, routerOptions: { maxParamLength: 5000 } });

await server.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: () => ({ db }),
    onError({ path, error }) {
      server.log.error({ path, err: error }, 'tRPC 오류');
    },
  } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
});

const shutdown = async () => {
  await server.close();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.listen({ host: '127.0.0.1', port });
