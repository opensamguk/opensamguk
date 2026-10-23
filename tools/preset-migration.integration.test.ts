import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';

const run = promisify(execFile);
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname))
  throw new Error('T2-02 전용 테스트 DB가 필요합니다.');
const root = fileURLToPath(new URL('../', import.meta.url));
const dbRoot = join(root, 'packages/db');
const require = createRequire(join(dbRoot, 'package.json'));
const prismaCli = join(require.resolve('prisma/package.json'), '..', 'build/index.js');
const migration = '20261023040000_world_presets';

describe('T2-02 실제 PostgreSQL migration', () => {
  it.each(['preset_empty', 'preset_upgrade'] as const)(
    '%s의 빈 DB·기존 월드에 새 migration을 적용한다',
    async (schema) => {
      const db = createDb(url);
      const temp = await mkdtemp(join(dbRoot, '.preset-migration-'));
      const database = new URL(url);
      database.searchParams.set('schema', schema);
      const migrations = join(temp, 'migrations');
      const config = join(temp, 'prisma.config.ts');
      try {
        await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        const before = JSON.parse(
          await readFile(join(root, 'apps/engine/test/fixtures/replay-v1-b8f5074.json'), 'utf8'),
        ) as { origin: { initialStateHash: string } };
        await cp(join(dbRoot, 'prisma/migrations'), migrations, {
          recursive: true,
          filter: (source) => !source.includes(migration),
        });
        const initialMigrations = (await readdir(migrations)).filter((name) => /^\d/.test(name));
        expect(initialMigrations.length).toBeGreaterThan(0);
        await writeFile(
          config,
          `import { defineConfig } from 'prisma/config';\nexport default defineConfig({ schema: ${JSON.stringify(join(dbRoot, 'prisma/schema.prisma'))}, migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.DATABASE_URL } });\n`,
        );
        const deploy = () =>
          run(process.execPath, [prismaCli, 'migrate', 'deploy', '--config', config], {
            cwd: root,
            env: { ...process.env, DATABASE_URL: database.href },
            timeout: 60_000,
          });
        await deploy();
        if (schema === 'preset_upgrade') {
          await db.$executeRawUnsafe(
            `INSERT INTO "${schema}"."World" ("id", "name", "scenarioKey", "mapKey", "unitSetKey", "seed", "startYear", "turnTermMinutes", "initialStateHash", "statRules", "unitSet", "replayOrigin") VALUES ('legacy', 'legacy', '1030', 'che', 'basic', 'migration', 191, 60, $1, '{}'::jsonb, '{}'::jsonb, $2::jsonb)`,
            before.origin.initialStateHash,
            JSON.stringify(before.origin),
          );
        }
        await cp(join(dbRoot, 'prisma/migrations', migration), join(migrations, migration), { recursive: true });
        await deploy();
        await deploy();
        const columns = await db.$queryRaw<
          { column_name: string }[]
        >`SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = 'World' AND column_name IN ('presetKey', 'preset') ORDER BY column_name`;
        expect(columns.map((column) => column.column_name)).toEqual(['preset', 'presetKey']);
        if (schema === 'preset_upgrade') {
          const [world] = await db.$queryRawUnsafe<
            { presetKey: string | null; preset: unknown; initialStateHash: string; replayOrigin: unknown }[]
          >(
            `SELECT "presetKey", "preset", "initialStateHash", "replayOrigin" FROM "${schema}"."World" WHERE id = 'legacy'`,
          );
          expect(world).toEqual({
            presetKey: null,
            preset: null,
            initialStateHash: before.origin.initialStateHash,
            replayOrigin: before.origin,
          });
        }
      } finally {
        await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.$disconnect();
        await rm(temp, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
