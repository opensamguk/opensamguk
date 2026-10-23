import { createDb } from '@opensamguk/db';
import { buildServer } from '../src/server';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 DB가 필요합니다.');
const db = createDb(url);
const app = await buildServer({
  db,
  logging: false,
  realtime: {
    connectionString: url,
    applicationName: process.env.SSE_TEST_APPLICATION ?? 'messaging-worker',
    heartbeatMs: 100,
    reconnectMs: 50,
  },
});
const base = await app.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ base });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await db.$disconnect();
  process.exit(0);
}
process.on('message', () => {
  void shutdown();
});
process.on('disconnect', () => {
  void shutdown();
});
