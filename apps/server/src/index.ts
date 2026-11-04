import { createMailTransport } from './mail/transport';
import { resourceRoot } from '@opensamguk/shared/resource-root';
import { loadLoginAuditOptions } from './config/loginAudit';
import { startNotificationDispatcher } from './notifications/dispatcher';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL이 없습니다. .env.example을 .env로 복사하세요.');
  process.exit(1);
}

const mailTransport = createMailTransport({
  ...process.env,
  MAIL_TRANSPORT: process.env.MAIL_TRANSPORT ?? (process.env.NODE_ENV === 'production' ? undefined : 'capture'),
});
resourceRoot();
let loginAudit: ReturnType<typeof loadLoginAuditOptions>;
try {
  loginAudit = loadLoginAuditOptions(process.env);
} catch {
  console.error('로그인 조사 키 설정을 확인하세요.');
  process.exit(1);
}
const [{ createDb }, { buildServer }] = await Promise.all([import('@opensamguk/db'), import('./server')]);
const db = createDb(databaseUrl);
const port = Number(process.env.SERVER_PORT ?? 3001);
const server = await buildServer({ db, mailTransport, ...(loginAudit === undefined ? {} : { loginAudit }) });
const dispatcher = startNotificationDispatcher(
  db,
  {
    publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173',
    onSummary: ({ unknown }) => server.log.warn({ category: 'UNKNOWN', count: unknown }, '알림 전송 결과 불명'),
  },
  () => server.log.warn('알림 대기열 처리 실패'),
);

const shutdown = async () => {
  await dispatcher.stop();
  await server.close();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.listen({ host: '127.0.0.1', port });
