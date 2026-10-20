import { createDb } from '@opensamguk/db';
import { buildServer } from './server';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL이 없습니다. .env.example을 .env로 복사하세요.');
  process.exit(1);
}

const db = createDb(databaseUrl);
const port = Number(process.env.SERVER_PORT ?? 3001);

const server = await buildServer({ db });

const shutdown = async () => {
  await server.close();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.listen({ host: '127.0.0.1', port });
