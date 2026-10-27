import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, type PrismaClient } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { initializeResources, ResourceInitializationError } from './init-resources';
import { BODY_TAG, RESOURCE_INPUTS } from './resources-sql/convert';
import { INITIAL_NOTICE_FIXTURE, verifyInitialNotice } from './resources-sql/notice';
import { testDatabaseUrl } from './test-database';

const root = new URL('../', import.meta.url);
const migrationRoot = new URL('packages/db/prisma/migrations/', root);
interface PgClient {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  end(): Promise<void>;
}

function nativeClient(connectionString: string): PgClient {
  const dbRequire = createRequire(new URL('packages/db/package.json', root));
  const require = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
  const { Client } = require('pg') as { Client: new (options: { connectionString: string }) => PgClient };
  return new Client({ connectionString });
}

async function migrationFiles() {
  const entries = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const files = await Promise.all(
    entries.map(async (name) => {
      const raw = await readFile(new URL(`${name}/migration.sql`, migrationRoot));
      return { name, sql: raw.toString('utf8'), rawHash: createHash('sha256').update(raw).digest('hex') };
    }),
  );
  const targets = files.filter((file) => /CREATE TABLE "GameResource"/.test(file.sql));
  if (targets.length !== 1) throw new Error('H1 자원 schema와 migration을 먼저 반영하세요.');
  const target = targets[0]!;
  return { files, target };
}

interface Fixture {
  db: PrismaClient;
  native: PgClient;
  url: URL;
  sql: string;
  applyCatalog(): Promise<void>;
}

async function withDatabase(action: (fixture: Fixture) => Promise<void>, beforeCatalog = false): Promise<void> {
  const { files, target } = await migrationFiles();
  if (!process.env.TEST_DATABASE_URL) throw new Error('전용 TEST_DATABASE_URL이 필요합니다.');
  const reference = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  const name = `resource_init_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(reference);
  url.pathname = `/${name}`;
  testDatabaseUrl({ TEST_DATABASE_URL: url.href, DATABASE_URL: process.env.DATABASE_URL });
  const adminUrl = new URL(reference);
  adminUrl.pathname = '/postgres';
  const admin = nativeClient(adminUrl.href);
  const native = nativeClient(url.href);
  let created = false;
  let createdOID: string | undefined;
  let connected = false;
  let db: PrismaClient | undefined;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await admin.connect();
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    createdOID = (
      await admin.query<{ oid: string }>('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [name])
    ).rows[0]!.oid;
    await native.connect();
    connected = true;
    for (const file of files.filter((file) => !beforeCatalog || file.name < target.name)) await native.query(file.sql);
    const sql = (await readFile(new URL('packages/db/sql/resources-init.sql', root), 'utf8')).replaceAll('\r\n', '\n');
    expect(createHash('sha256').update(sql).digest('hex')).toBe(
      '6822b04a6981a51c26d1d03ff31cf8acd76417c74e0696d1e3b98e574fc32754',
    );
    db = createDb(url.href);
    await action({
      db,
      native,
      url,
      sql,
      applyCatalog: async () => {
        await native.query(target.sql);
      },
    });
    // 최종 checkout에서 읽은 기존 SQL의 바이트는 migration 실행 뒤에도 같다.
    for (const file of files.filter((file) => file.name < target.name)) {
      expect(
        createHash('sha256')
          .update(await readFile(new URL(file.name + '/migration.sql', migrationRoot)))
          .digest('hex'),
      ).toBe(file.rawHash);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await db?.$disconnect();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (connected) await native.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (created && !createdOID) cleanupErrors.push(new Error('만든 DB의 OID를 확인하지 못해 정리하지 않았습니다.'));
    if (created && createdOID) {
      try {
        const current = (
          await admin.query<{ oid: string }>('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [name])
        ).rows;
        expect(current).toEqual([{ oid: createdOID }]);
        let active = await admin.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1',
          [name],
        );
        // 소켓 종료 뒤 PostgreSQL이 자기 backend를 제거할 때까지 확인한다.
        for (let attempt = 0; active.rows[0]?.count !== 0 && attempt < 20; attempt++) {
          await delay(50);
          active = await admin.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1',
            [name],
          );
        }
        expect(active.rows).toEqual([{ count: 0 }]);
        expect(
          (await admin.query<{ oid: string }>('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [name]))
            .rows,
        ).toEqual([{ oid: createdOID }]);
        await admin.query(`DROP DATABASE "${name}"`);
        expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await admin.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failure && cleanupErrors.length)
    throw new AggregateError([failure, ...cleanupErrors], '시험과 자기 DB 정리가 실패했습니다.');
  if (failure) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '자기 DB 정리가 실패했습니다.');
}

async function allRows(native: PgClient): Promise<unknown[]> {
  return (
    await native.query<{ row: unknown }>('SELECT to_jsonb(g) AS row FROM "GameResource" g ORDER BY kind, name, version')
  ).rows.map((row) => row.row);
}

it('P1 빈 DB에 기존 SQL과 자원 migration 전체를 적용한다', async () => {
  await withDatabase(async ({ native }) => {
    expect(await allRows(native)).toEqual([]);
  });
});

it('P2 기존 월드·도시·replayOrigin은 자원 migration 뒤에도 같다', async () => {
  await withDatabase(async ({ db, native, applyCatalog }) => {
    const { worldId } = await saveInitialWorld(db, await monthlyFixture(), {
      name: '자원 이전',
      turnTermMinutes: 60,
      endYear: null,
      replayFormat: 'legacy',
    });
    const snapshot = async () => ({
      world: (await native.query('SELECT to_jsonb(w) AS row FROM "World" w WHERE id = $1', [worldId])).rows,
      cities: (
        await native.query('SELECT to_jsonb(c) AS row FROM "City" c WHERE "worldId" = $1 ORDER BY "cityKey"', [worldId])
      ).rows,
    });
    const before = await snapshot();
    await applyCatalog();
    expect(await snapshot()).toEqual(before);
  }, true);
});

it('P3 빈 표를 초기화하면 다섯 게시 행과 S0 해시를 저장한다', async () => {
  await withDatabase(async ({ db, native, sql }) => {
    expect(await initializeResources(db, sql)).toEqual({ inserted: 5, existing: 0 });
    const rows = await native.query<{
      kind: string;
      name: string;
      version: number;
      status: string;
      contentHash: string;
    }>('SELECT kind::text, name, version, status::text, "contentHash" FROM "GameResource"');
    expect(rows.rows).toHaveLength(5);
    for (const resource of RESOURCE_INPUTS)
      expect(rows.rows).toContainEqual({
        kind: resource.kind,
        name: resource.name,
        version: 1,
        status: 'PUBLISHED',
        contentHash: resource.contentHash,
      });
  });
});

it('P4 두 번째 초기화는 id와 시각을 포함해 모든 열을 보존한다', async () => {
  await withDatabase(async ({ db, native, sql }) => {
    await initializeResources(db, sql);
    const before = await allRows(native);
    expect(await initializeResources(db, sql)).toEqual({ inserted: 0, existing: 5 });
    expect(await allRows(native)).toEqual(before);
  });
});

it('P4 두 초기화가 경합해도 삽입·기존 행 수와 저장 내용은 같다', async () => {
  await withDatabase(async ({ db, native, sql }) => {
    const results = await Promise.all([initializeResources(db, sql), initializeResources(db, sql)]);
    expect(results.sort((a, b) => a.inserted - b.inserted)).toEqual([
      { inserted: 0, existing: 5 },
      { inserted: 5, existing: 0 },
    ]);
    expect(await allRows(native)).toHaveLength(5);
  });
});

it.each(['content', 'status', 'source', 'contentHash'] as const)(
  'P5~P8 기존 %s 충돌은 나머지 네 행도 저장하지 않는다',
  async (field) => {
    await withDatabase(async ({ db, native, sql }) => {
      const resource = RESOURCE_INPUTS[0];
      const content = JSON.parse(await readFile(new URL(resource.path, root), 'utf8'));
      const source = `${resource.path}; ${content.$comment}`;
      const status = field === 'status' ? 'DRAFT' : 'PUBLISHED';
      await native.query(
        'INSERT INTO "GameResource" (id,kind,name,version,status,content,"contentHash",source,"createdBy","publishedAt") VALUES ($1,$2,$3,1,$4,$5::jsonb,$6,$7,NULL,$8)',
        [
          randomUUID(),
          resource.kind,
          resource.name,
          status,
          JSON.stringify(field === 'content' ? { ...content, conflict: true } : content),
          field === 'contentHash' ? '0'.repeat(64) : resource.contentHash,
          field === 'source' ? '다른 출처' : source,
          status === 'DRAFT' ? null : new Date(),
        ],
      );
      const before = await allRows(native);
      try {
        await initializeResources(db, sql);
        throw new Error('충돌한 초기화가 통과했습니다.');
      } catch (error) {
        expect(error).toBeInstanceOf(ResourceInitializationError);
        expect((error as ResourceInitializationError).keys).toEqual(['MAP/che/1']);
      }
      expect(await allRows(native)).toEqual(before);
    });
  },
);

it('P9 다섯째 행의 CHECK 실패는 앞의 네 행도 롤백한다', async () => {
  await withDatabase(async ({ db, native, sql }) => {
    const broken = sql.replace(
      "'PORTRAIT_MAP', 'rtk14-map', 1, 'PUBLISHED'",
      "'PORTRAIT_MAP', 'rtk14-map', 0, 'PUBLISHED'",
    );
    expect(broken).not.toBe(sql);
    const error = await initializeResources(db, broken).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ResourceInitializationError);
    // CHECK 누락 때의 단일 키 충돌 오류와 구분한다. CHECK 오류는 대상 묶음으로 가려진다.
    const keys = RESOURCE_INPUTS.map((resource) => `${resource.kind}/${resource.name}/1`);
    expect(error).toMatchObject({ keys, message: `초기화 자원 SQL 실패: ${keys.join(', ')}` });
    expect(await allRows(native)).toEqual([]);
  });
});

it('P10 DB 출처와 SQL의 MIT 전문·초상 고지는 원문과 같다', async () => {
  await withDatabase(async ({ db, native, sql }) => {
    await initializeResources(db, sql);
    const rows = (await native.query<{ kind: string; source: string }>('SELECT kind::text, source FROM "GameResource"'))
      .rows;
    for (const resource of RESOURCE_INPUTS) {
      const content = JSON.parse(await readFile(new URL(resource.path, root), 'utf8'));
      expect(rows).toContainEqual({ kind: resource.kind, source: `${resource.path}; ${content.$comment}` });
    }
    const header = sql
      .slice(sql.indexOf('\n') + 1, sql.indexOf(`\n\nDO ${BODY_TAG}`))
      .split('\n')
      .map((line) => (line === '--' ? '' : line.slice(3)))
      .join('\n');
    expect(header).toBe(verifyInitialNotice(await readFile(new URL(INITIAL_NOTICE_FIXTURE, root), 'utf8')));
  });
});

it.each([
  'UPDATE "GameResource" SET content = \'{}\'::jsonb',
  `UPDATE "GameResource" SET "contentHash" = '${'0'.repeat(64)}'`,
  'UPDATE "GameResource" SET source = \'다른 출처\'',
  'UPDATE "GameResource" SET status = \'DRAFT\', "publishedAt" = NULL',
  'UPDATE "GameResource" SET name = \'changed\'',
  'UPDATE "GameResource" SET version = 2',
  'DELETE FROM "GameResource"',
])('P11 게시 행 변경·삭제는 거부하고 행은 보존한다 (%#)', async (statement) => {
  await withDatabase(async ({ db, native, sql }) => {
    await initializeResources(db, sql);
    const before = await allRows(native);
    await expect(native.query(`${statement} WHERE kind = 'MAP'`)).rejects.toThrow();
    expect(await allRows(native)).toEqual(before);
    await native.query(
      "INSERT INTO \"GameResource\" (id,kind,name,version,status,content,\"contentHash\",source) VALUES ($1,'MAP','extra',1,'DRAFT','{}'::jsonb,$2,'시험 출처')",
      [randomUUID(), hashState({})],
    );
    expect(await allRows(native)).toHaveLength(6);
  });
});

it('P12 다섯 jsonb 내용은 원본 전체와 깊게 같고 S0 해시도 같다', async () => {
  await withDatabase(async ({ db, native, sql }) => {
    await initializeResources(db, sql);
    const rows = (
      await native.query<{ kind: string; content: unknown; contentHash: string }>(
        'SELECT kind::text, content, "contentHash" FROM "GameResource"',
      )
    ).rows;
    const textDifferences = [];
    for (const resource of RESOURCE_INPUTS) {
      const original = JSON.parse(await readFile(new URL(resource.path, root), 'utf8'));
      const row = rows.find((row) => row.kind === resource.kind)!;
      expect(row.content).toEqual(original);
      expect(hashState(row.content)).toBe(resource.contentHash);
      expect(row.contentHash).toBe(resource.contentHash);
      textDifferences.push({
        kind: resource.kind,
        different: JSON.stringify(row.content) !== JSON.stringify(original),
      });
    }
    console.info('jsonb 글자열 순서 관측', textDifferences);
  });
});

it('P29 같은 초기화 CLI의 후검증 실패는 종료 1·성공 출력 없음·전체 롤백이다', async () => {
  await withDatabase(async ({ native, url, sql }) => {
    const hash = RESOURCE_INPUTS[4].contentHash;
    const broken = sql.replaceAll(hash, '0'.repeat(64));
    expect(broken).not.toBe(sql);
    const directory = await mkdtemp(join(tmpdir(), 't477-init-'));
    let failure: unknown;
    let cleanupError: unknown;
    try {
      const file = join(directory, 'wrong-hash.sql');
      await writeFile(file, broken, 'utf8');
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('node_modules/tsx/dist/cli.mjs', root)),
          fileURLToPath(new URL('tools/init-resources.ts', root)),
          '--sql',
          file,
        ],
        {
          cwd: fileURLToPath(root),
          env: { ...process.env, DATABASE_URL: url.href },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += String(data);
      });
      child.stderr.on('data', (data) => {
        stderr += String(data);
      });
      const exit = await new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', resolveExit);
      });
      expect(exit).toBe(1);
      expect(stdout).not.toContain('초기화 자원 저장');
      expect(stderr).toContain('초기화 자원 해시 불일치: PORTRAIT_MAP/rtk14-map/1');
      expect(stdout + stderr).not.toMatch(/postgres(?:ql)?:\/\//);
      expect(await allRows(native)).toEqual([]);
    } catch (error) {
      failure = error;
    }
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('t477-init-')) {
      cleanupError = new Error('자기 임시 경로가 아닙니다.');
    } else {
      try {
        await rm(directory, { recursive: true });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (failure && cleanupError)
      throw new AggregateError([failure, cleanupError], '시험과 자기 임시 파일 정리가 실패했습니다.');
    if (failure) throw failure;
    if (cleanupError) throw cleanupError;
  });
});
