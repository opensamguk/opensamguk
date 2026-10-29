import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDb } from '../../packages/db/src/index';
import { buildServer } from '../../apps/server/src/server';
import { LOAD_FIXTURE_POLICY, loadDatabaseName } from './contract';

export function loadDatabaseUrl(env: NodeJS.ProcessEnv): string {
  // URL/JSON 파싱 예외의 입력 조각을 출력하지 않는다.
  try {
    const expected = loadDatabaseName(env.LOAD_RUN_ID ?? '');
    const url = new URL(env.DATABASE_URL ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== 'postgres' ||
      decodeURIComponent(url.pathname.slice(1)) !== expected ||
      !url.username ||
      !url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.href;
  } catch {
    throw new Error('LOAD_DEDICATED_DATABASE_REQUIRED');
  }
}

async function main() {
  const db = createDb(loadDatabaseUrl(process.env));
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  const starting = buildServer({
    db,
    production: false,
    secureCookies: false,
    logging: false,
    publicOrigin: 'http://server:3001',
    legalPolicy: LOAD_FIXTURE_POLICY,
    withdrawalPolicy: null,
    capacityMonitor: null,
    emailVerificationRequired: true,
  });
  let listening: Promise<string> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      try {
        server = await starting;
      } catch {
        /* 시작 실패도 disconnect를 생략하지 않는다. */
      }
      try {
        await listening;
      } catch {
        /* 듣기 실패 뒤에도 server.close를 실행한다. */
      }
      try {
        await server?.close();
      } catch {
        failures.push(new Error('LOAD_SERVER_CLOSE_FAILED'));
      }
      try {
        await db.$disconnect();
      } catch {
        failures.push(new Error('LOAD_SERVER_DATABASE_CLOSE_FAILED'));
      }
      if (failures.length) throw new AggregateError(failures, 'LOAD_SERVER_CLEANUP_FAILED');
    })());
  const shutdown = () => {
    void close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    server = await starting;
    if (closing) {
      await closing;
      return;
    }
    listening = server.listen({ host: '0.0.0.0', port: 3001 });
    await listening;
  } catch {
    await close();
    throw new Error('LOAD_SERVER_FAILED');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write('LOAD_SERVER_FAILED\n');
    process.exitCode = 1;
  }
}
