import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test as base } from '@playwright/test';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import type { LegalPolicy } from '../apps/server/src/legal/policy';
import type { MailMessage } from '../apps/server/src/mail/transport';
import { initializeResources } from '../tools/init-resources';
import { e2eDatabaseUrl } from './account';
import { confirmDisconnectedDatabase } from '../tools/test-db-close';
import { listenLegalHttp, listenLegalLoopback } from './legalFixturePorts';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const media: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export interface LegalStack {
  db: ReturnType<typeof createDb>;
  origin: string;
  database: string;
  failed: boolean;
  messages: MailMessage[];
  restart(policy: LegalPolicy | null, emailRequired?: boolean): Promise<void>;
  productionPending(): Promise<{ origin: string; close(): Promise<void> }>;
}

// 공개 dist를 loopback 출처에서 내보내고 /trpc와 SSE를 자기 실제 API로 중계한다.
async function staticBridge(apiOrigin: () => string) {
  const dist = resolve(root, 'apps/web/dist');
  const manifest = JSON.parse(await readFile(join(dist, 'public-build.json'), 'utf8')) as { mode: string };
  assert.equal(manifest.mode, 'public');
  const jobs = new Set<Promise<void>>();
  const jobErrors: unknown[] = [];
  const controllers = new Set<AbortController>();
  const server = createServer((request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    response.once('close', () => controller.abort());
    const job = (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname.startsWith('/trpc/') || url.pathname.startsWith('/sse')) {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(request.headers))
            if (value !== undefined && !['host', 'connection', 'transfer-encoding'].includes(key))
              headers[key] = Array.isArray(value) ? value.join(',') : value;
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of request) {
            const bytes = Buffer.from(chunk as Uint8Array);
            length += bytes.length;
            if (length > 1_048_576) {
              response.writeHead(413).end();
              return;
            }
            chunks.push(bytes);
          }
          const method = request.method ?? 'GET';
          const upstream = await fetch(apiOrigin() + url.pathname + url.search, {
            method,
            headers,
            signal: controller.signal,
            ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
          });
          response.statusCode = upstream.status;
          for (const [key, value] of upstream.headers)
            if (!['set-cookie', 'connection', 'transfer-encoding'].includes(key)) response.setHeader(key, value);
          const cookies = upstream.headers.getSetCookie();
          if (cookies.length) response.setHeader('set-cookie', cookies);
          const reader = upstream.body?.getReader();
          try {
            while (reader) {
              const item = await reader.read();
              if (item.done) break;
              response.write(item.value);
            }
          } finally {
            await reader?.cancel().catch(() => undefined);
          }
          response.end();
          return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405).end();
          return;
        }
        const pathname = decodeURIComponent(url.pathname);
        const path = resolve(dist, '.' + pathname);
        if (path !== dist && !path.startsWith(dist + sep)) {
          response.writeHead(403).end();
          return;
        }
        const file = extname(path) ? path : join(dist, 'index.html');
        const bytes = await readFile(file);
        response.setHeader('content-type', media[extname(file)] ?? 'application/octet-stream');
        response.setHeader('x-content-type-options', 'nosniff');
        response.setHeader('cache-control', 'no-store');
        response.end(request.method === 'HEAD' ? undefined : bytes);
      } catch {
        if (!response.destroyed) {
          if (!response.headersSent) response.statusCode = 502;
          response.end('시험 서비스 요청 실패');
        }
      } finally {
        controllers.delete(controller);
      }
    })();
    jobs.add(job);
    void job.then(
      () => jobs.delete(job),
      (error) => {
        jobs.delete(job);
        jobErrors.push(error);
      },
    );
  });
  const close = async () => {
    for (const controller of controllers) controller.abort();
    const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    try {
      server.closeAllConnections();
    } catch (error) {
      jobErrors.push(error);
    }
    try {
      await closed;
    } catch (error) {
      jobErrors.push(error);
    }
    while (jobs.size) await Promise.allSettled([...jobs]);
    if (jobErrors.length) throw new AggregateError(jobErrors, '자기 정적 서버 종료 또는 요청 정착 실패');
  };
  try {
    await listenLegalHttp(server);
    const address = server.address();
    assert(address !== null && typeof address !== 'string');
    return { origin: `http://127.0.0.1:${address.port}`, close };
  } catch (error) {
    if (server.listening) {
      try {
        await close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '자기 정적 서버 준비 또는 종료 실패', { cause: cleanupError });
      }
    }
    throw error;
  }
}

export const test = base.extend<Record<never, never>, { legalStack: LegalStack }>({
  legalStack: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const original = e2eDatabaseUrl(),
        suffix = randomBytes(6).toString('hex');
      const database = `e2e_legal_${suffix}_test`;
      assert(/^e2e_legal_[a-f0-9]{12}_test$/.test(database));
      const url = new URL(original);
      url.pathname = '/' + database;
      const adminUrl = new URL(original);
      adminUrl.pathname = '/postgres';
      const admin = createDb(adminUrl.href);
      const saved = { DATABASE_URL: process.env.DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL };
      const errors: unknown[] = [],
        messages: MailMessage[] = [];
      const transport = {
        async send(message: MailMessage) {
          messages.push(message);
        },
      };
      const extraServers = new Set<Awaited<ReturnType<typeof buildServer>>>();
      let db: ReturnType<typeof createDb> | undefined, api: Awaited<ReturnType<typeof buildServer>> | undefined;
      let closeWeb: (() => Promise<void>) | undefined,
        created = false,
        oid: string | undefined,
        failure: unknown,
        apiOrigin = '';
      const receipt: Record<string, unknown> = { database, actualPostgres: true, actualApi: true, publicBuild: true };
      let stack: LegalStack | undefined;
      try {
        assert.equal(
          (
            await admin.$queryRawUnsafe<Array<{ oid: string }>>(
              'SELECT oid::text AS oid FROM pg_database WHERE datname=$1',
              database,
            )
          ).length,
          0,
        );
        await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
        created = true;
        const [identity] = await admin.$queryRawUnsafe<Array<{ oid: string }>>(
          'SELECT oid::text AS oid FROM pg_database WHERE datname=$1',
          database,
        );
        oid = identity!.oid;
        const prisma = dirname(createRequire(join(root, 'packages/db/package.json')).resolve('prisma/package.json'));
        try {
          await run(process.execPath, [join(prisma, 'build/index.js'), 'migrate', 'deploy'], {
            cwd: join(root, 'packages/db'),
            env: { ...process.env, DATABASE_URL: url.href },
          });
        } catch {
          throw new Error('동의 화면 전용 DB migration 실패');
        }
        process.env.DATABASE_URL = url.href;
        process.env.TEST_DATABASE_URL = url.href;
        db = createDb(url.href);
        await initializeResources(db, await readFile(join(root, 'packages/db/sql/resources-init.sql'), 'utf8'));
        const bridge = await staticBridge(() => apiOrigin);
        closeWeb = bridge.close;
        const origin = bridge.origin;
        const restart = async (policy: LegalPolicy | null, emailRequired = false) => {
          await api?.close();
          api = await buildServer({
            db: db!,
            production: false,
            logging: false,
            publicOrigin: origin,
            emailVerificationRequired: emailRequired,
            legalPolicy: policy,
            mailTransport: transport,
            realtime: { connectionString: url.href, applicationName: `legal-${suffix}` },
          });
          await api.ready();
          await listenLegalLoopback(
            (port) => api!.listen({ host: '127.0.0.1', port }),
            () => api!.server.listening,
          );
          apiOrigin = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
        };
        await restart(null);
        stack = {
          db,
          origin,
          database,
          messages,
          restart,
          failed: false,
          async productionPending() {
            const server = await buildServer({
              db: db!,
              production: true,
              logging: false,
              publicOrigin: 'https://legal-pending.example.test',
              mailTransport: transport,
              realtime: { connectionString: url.href, applicationName: `legal-production-${suffix}` },
            });
            extraServers.add(server);
            await server.ready();
            await listenLegalLoopback(
              (port) => server.listen({ host: '127.0.0.1', port }),
              () => server.server.listening,
            );
            const previous = apiOrigin;
            const productionOrigin = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
            apiOrigin = productionOrigin;
            return {
              origin: productionOrigin,
              async close() {
                if (apiOrigin === productionOrigin) apiOrigin = previous;
                await server.close();
                extraServers.delete(server);
              },
            };
          },
        };
        receipt.setupPassed = true;
        await use(stack);
      } catch (error) {
        failure = error;
      }
      const cleanup = async (label: string, action: () => Promise<unknown>) => {
        try {
          await action();
          receipt[label] = true;
        } catch (error) {
          errors.push(error);
          receipt[label] = false;
        }
      };
      await cleanup('webClosed', async () => closeWeb?.());
      for (const server of extraServers) await cleanup('extraApiClosed', () => server.close());
      await cleanup('apiClosed', async () => api?.close());
      await cleanup('dbDisconnected', async () => db?.$disconnect());
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      receipt.envRestored =
        process.env.DATABASE_URL === saved.DATABASE_URL && process.env.TEST_DATABASE_URL === saved.TEST_DATABASE_URL;
      if (created)
        await cleanup('ownDatabaseChecked', async () => {
          assert(oid);
          const disconnected = await confirmDisconnectedDatabase(
            {
              query: async (sql, values = []) => ({
                rows: await admin.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...values),
              }),
            },
            database,
            oid,
          );
          Object.assign(receipt, disconnected);
          if (!failure && !stack?.failed && errors.length === 0) {
            await admin.$executeRawUnsafe(`DROP DATABASE "${database}"`);
            receipt.dropped = true;
          } else receipt.dropped = false;
        });
      await cleanup('adminDisconnected', () => admin.$disconnect());
      receipt.failedTest = stack?.failed ?? false;
      receipt.cleanupErrorCount = errors.length;
      await mkdir(join(root, 'test-results'), { recursive: true });
      await writeFile(
        join(root, 'test-results', `legal-fixture-${database}.json`),
        JSON.stringify(receipt, null, 2) + '\n',
      );
      if (failure || errors.length)
        throw new AggregateError([...(failure ? [failure] : []), ...errors], '동의 화면 시험 또는 자기 자원 정리 실패');
    },
    { scope: 'worker' },
  ],
});

test.afterEach(async ({ legalStack }, info) => {
  if (info.status !== info.expectedStatus) legalStack.failed = true;
});
export { expect } from '@playwright/test';
