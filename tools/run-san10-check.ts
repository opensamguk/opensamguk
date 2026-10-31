import { spawnSync } from 'node:child_process';
import { testDatabaseUrl } from './test-database';
import { pnpmCli } from './node-cli';

const env = { ...process.env, DATABASE_URL: testDatabaseUrl(process.env).href };
const result = spawnSync(...pnpmCli(['exec', 'playwright', 'test', '--config', 'playwright.san10.config.ts'], env), {
  env,
  stdio: 'inherit',
});
if (result.error) throw Error('SAN10 브라우저 검증을 실행하지 못했습니다.');
process.exitCode = result.status ?? 1;
