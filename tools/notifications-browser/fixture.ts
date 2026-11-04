import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../../packages/db/src/index';
import { appRouter } from '../../apps/server/src/router';
import { buildServer } from '../../apps/server/src/server';
import type { DiscordWebhookTransport } from '../../apps/server/src/notifications/discordWebhook';
import { listenLegalHttp } from '../../e2e/legalFixturePorts';

export const API_PORT = 18751;
export const WEB_PORT = 18752;
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
export const RECEIPT_PATH = fileURLToPath(new URL('../../test-results/notification-receiver.json', import.meta.url));
export const TRIAL_CONTENT = '[오픈삼국] 디스코드 알림 연결을 확인했습니다.';
const FAKE_URL = 'https://discord.com/api/webhooks/100000000000000001/e2e-fake-token_0123456789abcdefWX34';
const routes = ['notification.get', 'notification.setDiscord', 'notification.setEvents', 'notification.removeDiscord'];

export function fixtureDatabase(env: NodeJS.ProcessEnv): string {
  if (env.NODE_ENV === 'production') throw Error('알림 시험 서버는 운영에서 실행할 수 없습니다.');
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? '');
  } catch {
    throw Error('loopback 전용 테스트 DB가 필요합니다.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/^\/[a-z][a-z0-9_]*_test$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw Error('loopback 전용 테스트 DB가 필요합니다.');
  return url.href;
}

export function assertNotificationRoutes(procedures: Readonly<Record<string, unknown>>) {
  if (routes.some((path) => !Object.hasOwn(procedures, path))) throw Error('알림 API 네 개가 모두 필요합니다.');
}

export async function startReceiver(receiptPath = RECEIPT_PATH) {
  const receipt = { requests: 0, valid: 0, invalid: 0, method: null as 'POST' | null, content: null as string | null };
  const pending = new Set<Promise<void>>();
  const save = async () => {
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify(receipt));
  };
  await save();
  const server = createServer((request, response) => {
    const job = (async () => {
      receipt.requests++;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += Buffer.byteLength(chunk);
          if (size > 16384) throw Error();
          chunks.push(Buffer.from(chunk));
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          request.method !== 'POST' ||
          request.url !== '/trial' ||
          request.headers['content-type'] !== 'application/json' ||
          JSON.stringify(body) !== JSON.stringify({ content: TRIAL_CONTENT, allowed_mentions: { parse: [] } })
        )
          throw Error();
        receipt.valid++;
        receipt.method = 'POST';
        receipt.content = TRIAL_CONTENT;
        await save();
        response.writeHead(204).end();
      } catch {
        receipt.invalid++;
        await save();
        response.writeHead(400).end();
      }
    })();
    pending.add(job);
    void job.then(
      () => pending.delete(job),
      () => {
        pending.delete(job);
        response.destroy();
      },
    );
  });
  await listenLegalHttp(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport: DiscordWebhookTransport = (url, init) => {
    if (url !== FAKE_URL) return Promise.reject(Error('정해진 가짜 주소만 시험할 수 있습니다.'));
    return fetch(`${origin}/trial`, init);
  };
  return {
    origin,
    transport,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await Promise.allSettled([...pending]);
    },
  };
}

export async function startNotificationFixture(env: NodeJS.ProcessEnv) {
  const database = fixtureDatabase(env);
  assertNotificationRoutes(appRouter._def.procedures);
  const db = createDb(database);
  const receiver = await startReceiver();
  let api: Awaited<ReturnType<typeof buildServer>> | undefined;
  const close = async () => {
    try {
      await api?.close();
    } finally {
      try {
        await receiver.close();
      } finally {
        await db.$disconnect();
      }
    }
  };
  try {
    api = await buildServer({
      db,
      publicOrigin: WEB_ORIGIN,
      logging: false,
      notificationTransport: receiver.transport,
    });
    api.get('/notification-fixture-ready', async () => ({ ready: true }));
    await api.listen({ host: '127.0.0.1', port: API_PORT });
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
