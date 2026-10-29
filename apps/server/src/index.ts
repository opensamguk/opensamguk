import { createMailTransport } from './mail/transport';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL이 없습니다. .env.example을 .env로 복사하세요.');
  process.exit(1);
}

const mailTransport = createMailTransport({
  ...process.env,
  MAIL_TRANSPORT: process.env.MAIL_TRANSPORT ?? (process.env.NODE_ENV === 'production' ? undefined : 'capture'),
});
const [{ createDb }, { buildServer }] = await Promise.all([import('@opensamguk/db'), import('./server')]);
const db = createDb(databaseUrl);
const port = Number(process.env.SERVER_PORT ?? 3001);
const server = await buildServer({ db, mailTransport });

const shutdown = async () => {
  await server.close();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.listen({ host: '127.0.0.1', port });
