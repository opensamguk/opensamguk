import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test as base } from '@playwright/test';
import { e2eDatabaseUrl } from './account';

// T2-25 공개 지도 E2E만 쓰는 실제 DB·API·웹 묶음. 공개 지도는 공개 월드 전체를 보이므로 다른 시험이 남긴 월드와 섞이지 않게
// 이 worker가 새 _test DB를 만들고 migration을 적용한 뒤 그 DB를 쓰는 자기 API 서버와 Vite 웹 서버를 띄운다.
// 이미 떠 있는 3001·5173 서버와 공유 DB의 행은 건드리지 않는다. 끝나면 자기 서버를 닫고 자기 DB 연결이 0인지 확인한 뒤
// 자기 DB만 지운다. 준비와 정리 결과는 test-results/t2-25-fixture-*.json에 남긴다.

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const vitePrefix = 't2-25-vite-';

export interface PublicMapStack {
  database: string;
  databaseUrl: string;
  apiOrigin: string;
  webOrigin: string;
}

interface ViteServer {
  listen(): Promise<unknown>;
  close(): Promise<void>;
}

// 빈 포트를 잠깐 열어 번호만 얻는다. Vite는 strictPort라 그 사이 다른 프로세스가 가져가면 다른 포트로 가지 않고 실패한다.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

// packages/db의 prisma CLI를 지금 node로 직접 실행한다. Windows에서 pnpm.cmd를 spawn하지 않는다.
async function migrate(url: string): Promise<string> {
  const prismaDir = dirname(createRequire(join(root, 'packages/db/package.json')).resolve('prisma/package.json'));
  const { stdout } = await run(process.execPath, [join(prismaDir, 'build/index.js'), 'migrate', 'deploy'], {
    cwd: join(root, 'packages/db'),
    env: { ...process.env, DATABASE_URL: url },
  });
  return stdout;
}

// apps/web의 vite와 기존 vite.config.ts로 같은 화면 소스를 띄운다. 포트와 API 주소만 이 묶음 것으로 바꾼다.
// 의존성 캐시는 임시 폴더에 두어 5173 서버의 캐시를 고치지 않는다.
async function startWeb(port: number, apiOrigin: string, cacheDir: string): Promise<ViteServer> {
  const webRoot = join(root, 'apps/web');
  const vitePath = createRequire(join(webRoot, 'package.json')).resolve('vite');
  const { createServer: createVite } = (await import(pathToFileURL(vitePath).href)) as {
    createServer: (config: Record<string, unknown>) => Promise<ViteServer>;
  };
  const vite = await createVite({
    configFile: join(webRoot, 'vite.config.ts'),
    root: webRoot,
    cacheDir,
    logLevel: 'error',
    clearScreen: false,
    server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/trpc': apiOrigin, '/sse': apiOrigin } },
  });
  try {
    await vite.listen();
  } catch (error) {
    await vite.close();
    throw error;
  }
  return vite;
}

async function record(name: string, data: unknown) {
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results', name), `${JSON.stringify(data, null, 2)}\n`);
}

export const test = base.extend<object, { publicMapStack: PublicMapStack }>({
  publicMapStack: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      // 원래 주소가 _test 전용 DB인지 먼저 확인하고 같은 서버·계정에 새 이름의 _test DB를 만든다. 있는 DB는 지우거나 비우지 않는다.
      const original = e2eDatabaseUrl();
      const database = `e2e_public_map_${randomBytes(6).toString('hex')}_test`;
      if (!/^[a-z0-9_]+_test$/.test(database)) throw new Error('공개 지도 E2E DB 이름이 잘못되었습니다.');
      const own = new URL(original);
      own.pathname = `/${database}`;
      const adminUrl = new URL(original);
      adminUrl.pathname = '/postgres';
      const databaseUrl = own.href;

      const { createDb } = await import('../packages/db/src/index');
      const { buildServer } = await import('../apps/server/src/server');
      const admin = createDb(adminUrl.href);
      const saved = { DATABASE_URL: process.env.DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL };
      const connections = async () =>
        (
          await admin.$queryRaw<
            Array<{ n: number }>
          >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${database}`
        )[0]!.n;
      const exists = async () =>
        (
          await admin.$queryRaw<
            Array<{ n: number }>
          >`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${database}`
        )[0]!.n;
      const cleanup: Record<string, unknown> = { database };
      let created = false;
      let db: ReturnType<typeof createDb> | undefined;
      let api: Awaited<ReturnType<typeof buildServer>> | undefined;
      let vite: ViteServer | undefined;
      let cacheDir: string | undefined;
      let failure: unknown;
      const errors: unknown[] = [];
      try {
        await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
        created = true;
        const migrated = await migrate(databaseUrl);

        // withE2eDb·holdLease는 DATABASE_URL을 읽는다. 이 worker 안에서만 자기 DB로 바꾸고 끝나면 되돌린다.
        // 이 worker fixture를 쓰는 파일은 다른 파일과 worker를 나눠 쓰지 않는다.
        process.env.DATABASE_URL = databaseUrl;
        process.env.TEST_DATABASE_URL = databaseUrl;

        // 서버는 평소처럼 Date.now로 지연을 판정한다. 브라우저 POST의 Origin은 자기 웹 출처와 같아야 받는다.
        const webPort = await freePort();
        const webOrigin = `http://127.0.0.1:${webPort}`;
        db = createDb(databaseUrl);
        api = await buildServer({
          db,
          logging: false,
          publicOrigin: webOrigin,
          realtime: { connectionString: databaseUrl },
        });
        await api.listen({ host: '127.0.0.1', port: 0 });
        const apiOrigin = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
        cacheDir = await mkdtemp(join(tmpdir(), vitePrefix));
        vite = await startWeb(webPort, apiOrigin, cacheDir);

        await record('t2-25-fixture-setup.json', {
          database,
          apiOrigin,
          webOrigin,
          exists: await exists(),
          migrate: migrated.trim().split('\n').slice(-3),
        });
        await use({ database, databaseUrl, apiOrigin, webOrigin });
      } catch (error) {
        failure = error;
      } finally {
        const step = async (name: string, work: () => Promise<unknown>) => {
          try {
            await work();
            cleanup[name] = true;
          } catch (error) {
            cleanup[name] = String(error);
            errors.push(error);
          }
        };
        await step('webClosed', async () => vite?.close());
        await step('apiClosed', async () => api?.close());
        await step('apiDbDisconnected', async () => db?.$disconnect());
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        // 값은 남기지 않고 두 변수가 원래 값으로 돌아왔는지만 남긴다.
        cleanup.envRestored =
          process.env.DATABASE_URL === saved.DATABASE_URL && process.env.TEST_DATABASE_URL === saved.TEST_DATABASE_URL;
        await step('viteCacheRemoved', async () => {
          if (cacheDir === undefined) return;
          // mkdtemp가 만든 tmpdir 바로 아래 t2-25-vite- 폴더일 때만 지운다. 아니면 지우지 않고 실패한다.
          const target = resolve(cacheDir);
          const name = basename(target);
          if (dirname(target) !== resolve(tmpdir()) || !name.startsWith(vitePrefix) || name.length <= vitePrefix.length)
            throw new Error('공개 지도 E2E Vite 캐시 경로가 임시 폴더 아래 자기 폴더가 아니라 지우지 않았습니다.');
          await rm(target, { recursive: true, force: true });
        });
        if (created)
          await step('dropped', async () => {
            // 풀이 끊긴 연결을 서버가 거두는 짧은 시간만 기다린다. 남아 있으면 지우지 않고 실패한다.
            let left = await connections();
            for (let tries = 0; left > 0 && tries < 50; tries++) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              left = await connections();
            }
            cleanup.connectionsBeforeDrop = left;
            if (left !== 0) throw new Error(`공개 지도 E2E DB에 연결 ${left}개가 남아 지우지 않았습니다.`);
            await admin.$executeRawUnsafe(`DROP DATABASE "${database}"`);
            cleanup.existsAfterDrop = await exists();
          });
        await step('adminDisconnected', () => admin.$disconnect());
        await step('recorded', () => record('t2-25-fixture-cleanup.json', cleanup));
      }
      // 정리를 모두 마친 뒤 본 실패를 먼저, 없으면 정리 실패를 던진다.
      if (failure !== undefined) throw failure;
      if (errors.length > 0) throw new AggregateError(errors, '공개 지도 E2E 묶음을 정리하지 못했습니다.');
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ publicMapStack }, use) => use(publicMapStack.webOrigin),
});

export { expect } from '@playwright/test';
