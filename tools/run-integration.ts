import { spawnSync } from 'node:child_process';
import { createDb } from '../packages/db/src/index';
import { testDatabaseUrl } from './test-database';
import { pnpmCli } from './node-cli';
import { integrationPartition } from './integration-partition';

const partition = integrationPartition(process.env.INTEGRATION_SUITE);
const url = testDatabaseUrl(process.env);
const databaseName = url.pathname.slice(1);
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const admin = createDb(adminUrl.href);
try {
  const existing = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${databaseName}`;
  if (existing.length === 0) {
    // The database name is validated by testDatabaseUrl before it reaches this identifier.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
  }
} finally {
  await admin.$disconnect();
}

const env = { ...process.env, DATABASE_URL: url.href, TEST_DATABASE_URL: url.href };
function run(args: string[]) {
  const result = spawnSync(...pnpmCli(args, env), { env, stdio: 'inherit' });
  if (result.error) throw new Error('통합 테스트 하위 명령을 실행하지 못했습니다.');
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['--filter', '@opensamguk/db', 'migrate']);
run(['db:init-resources']);
run(['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', ...partition]);
