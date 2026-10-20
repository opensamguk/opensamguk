import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// 루트 .env를 읽는다. 없으면(CI 등) 환경변수를 그대로 쓴다.
const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
