import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, readPublishedResources, type GameResourceRef, type PrismaClient } from '../packages/db/src/index';
import { buildInitialWorld, TICKS_PER_MONTH, type WorldInit } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import {
  composeInitialWorld,
  loadInitialWorldFromDb,
  readInitialResources,
  resourceRoot,
} from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { exportReplay, replayArchive, resourceHash } from '../apps/engine/src/replay';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { prepareWorldReset, verifyResetPreparation } from '../apps/engine/src/admin/resetPreparation';
import { savePreparedInitialWorld } from '../apps/engine/src/world/persistence';
import { scenarioTitle } from '../apps/server/src/routers/lobby';
import { validateWorldResources } from '../packages/rules/src/world/validate/index';
import baseline from './fixtures/t4-77-baseline.json';
import { initializeResources } from './init-resources';
import { BODY_TAG, convertResourcesToSql, RESOURCE_INPUTS, type ResourceTexts } from './resources-sql/convert';
import { INITIAL_NOTICE_FIXTURE, verifyInitialNotice } from './resources-sql/notice';
import { testDatabaseUrl } from './test-database';
import { getResource, listResources } from '../apps/server/src/resourceAdmin/read';
import { makeLimits, RESOURCE_PAYLOAD_LIMITS } from '../apps/server/src/resourceAdmin/payload';
import { simulateGame } from '../apps/engine/src/simulation';

vi.mock('../packages/rules/src/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/rules/src/index')>();
  return { ...actual, buildInitialWorld: vi.fn(actual.buildInitialWorld) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const root = new URL('../', import.meta.url);
const migrationRoot = new URL('packages/db/prisma/migrations/', root);
const buildSpy = vi.mocked(buildInitialWorld);
const fileSpy = vi.mocked(readFile);
const options = { scenario: '1030', map: 'che', seed: 'loader' };
const refs: GameResourceRef[] = RESOURCE_INPUTS.map(({ kind, name }) => ({ kind, name, version: 1 }));

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

interface Fixture {
  db: PrismaClient;
  url: string;
  native: PgClient;
  sql: string;
  dispose(): Promise<void>;
}

const draftMigration = '20261118000000_game_resource_draft_cas';
const singleDraftMigration = '20261119000000_game_resource_single_draft';
const discardMigration = '20261126000000_game_resource_draft_discard';

async function createFixture(
  config: {
    beforeCatalog?: boolean;
    beforeDrafts?: boolean;
    beforeSingleDraft?: boolean;
    beforeDiscard?: boolean;
    initialize?: boolean;
  } = {},
): Promise<Fixture> {
  if (!process.env.TEST_DATABASE_URL) throw new Error('전용 TEST_DATABASE_URL이 필요합니다.');
  const reference = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  const name = `resource_catalog_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(reference);
  url.pathname = `/${name}`;
  testDatabaseUrl({ TEST_DATABASE_URL: url.href, DATABASE_URL: process.env.DATABASE_URL });
  const adminUrl = new URL(reference);
  adminUrl.pathname = '/postgres';
  const admin = nativeClient(adminUrl.href);
  const native = nativeClient(url.href);
  let adminConnected = false;
  let connected = false;
  let created = false;
  let oid: string | undefined;
  let db: PrismaClient | undefined;
  const dispose = async () => {
    const errors: unknown[] = [];
    try {
      await db?.$disconnect();
    } catch (error) {
      errors.push(error);
    }
    try {
      if (connected) await native.end();
    } catch (error) {
      errors.push(error);
    }
    if (created && !oid) errors.push(new Error('만든 DB의 OID가 없어 정리하지 않았습니다.'));
    if (created && oid) {
      try {
        expect(
          (await admin.query<{ oid: string }>('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [name]))
            .rows,
        ).toEqual([{ oid }]);
        const connections = async () =>
          (
            await admin.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1',
              [name],
            )
          ).rows;
        let remaining = await connections();
        for (let attempt = 0; remaining[0]?.count !== 0 && attempt < 20; attempt++) {
          await delay(50);
          remaining = await connections();
        }
        if (remaining[0]?.count !== 0)
          console.error(
            'RESOURCE_CATALOG_CONNECTIONS',
            (
              await admin.query('SELECT pid,state,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=$1', [
                name,
              ])
            ).rows,
          );
        expect(remaining).toEqual([{ count: 0 }]);
        expect(
          (await admin.query<{ oid: string }>('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name]))
            .rows,
        ).toEqual([{ oid }]);
        await admin.query(`DROP DATABASE "${name}"`);
        expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      if (adminConnected) await admin.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, '자기 DB 정리가 실패했습니다.');
  };
  try {
    await admin.connect();
    adminConnected = true;
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    oid = (await admin.query<{ oid: string }>('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [name]))
      .rows[0]!.oid;
    await native.connect();
    connected = true;
    const folders = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const migrations = await Promise.all(
      folders.map(async (folder) => ({
        name: folder,
        sql: await readFile(new URL(`${folder}/migration.sql`, migrationRoot), 'utf8'),
      })),
    );
    const targets = migrations.filter((entry) => /CREATE TABLE "GameResource"/.test(entry.sql));
    expect(targets).toHaveLength(1);
    const before = config.beforeCatalog
      ? targets[0]!.name
      : config.beforeDrafts
        ? draftMigration
        : config.beforeSingleDraft
          ? singleDraftMigration
          : config.beforeDiscard
            ? discardMigration
            : undefined;
    for (const migration of migrations.filter((entry) => before === undefined || entry.name < before)) {
      await native.query(migration.sql);
    }
    const sql = (await readFile(new URL('packages/db/sql/resources-init.sql', root), 'utf8')).replaceAll('\r\n', '\n');
    expect(createHash('sha256').update(sql).digest('hex')).toBe(
      '6822b04a6981a51c26d1d03ff31cf8acd76417c74e0696d1e3b98e574fc32754',
    );
    db = createDb(url.href);
    if (config.initialize) await initializeResources(db, sql);
    return { db, url: url.href, native, sql, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], '시험 준비와 자기 DB 정리가 실패했습니다.', { cause: cleanup });
    }
    throw error;
  }
}

async function withDatabase(
  action: (fixture: Fixture) => Promise<void>,
  config: {
    beforeCatalog?: boolean;
    beforeDrafts?: boolean;
    beforeSingleDraft?: boolean;
    beforeDiscard?: boolean;
    initialize?: boolean;
  } = {},
) {
  const fixture = await createFixture(config);
  let failure: unknown;
  try {
    await action(fixture);
  } catch (error) {
    failure = error;
  }
  try {
    await fixture.dispose();
  } catch (cleanup) {
    if (failure)
      throw new AggregateError([failure, cleanup], '시험과 자기 DB 정리가 실패했습니다.', { cause: cleanup });
    throw cleanup;
  }
  if (failure) throw failure;
}

let shared: Fixture | undefined;
beforeAll(async () => {
  expect(Object.keys(baseline.seeds)).toHaveLength(13);
  shared = await createFixture({ initialize: true });
});
afterAll(async () => {
  await shared?.dispose();
});

function sharedDb() {
  if (!shared) throw new Error('공유 시험 DB가 준비되지 않았습니다.');
  return shared.db;
}

function resourceReads(start: number) {
  const resourcePath = fileURLToPath(resourceRoot).replaceAll('\\', '/');
  return fileSpy.mock.calls.slice(start).filter(([path]) => {
    const value = path instanceof URL ? fileURLToPath(path) : typeof path === 'string' ? path : '';
    return value.replaceAll('\\', '/').startsWith(resourcePath);
  });
}

async function noFileFallback(action: () => Promise<void>, builds = 0) {
  const buildStart = buildSpy.mock.calls.length;
  const fileStart = fileSpy.mock.calls.length;
  await action();
  expect(buildSpy.mock.calls.length - buildStart).toBe(builds);
  expect(resourceReads(fileStart)).toEqual([]);
}

async function insertResource(
  fixture: Fixture,
  ref: GameResourceRef,
  content: unknown,
  config: { draft?: boolean; contentHash?: string } = {},
) {
  await fixture.native.query(
    `INSERT INTO "GameResource" (id, kind, name, version, status, content, "contentHash", source, "publishedAt")
     VALUES ($1, $2::"GameResourceKind", $3, $4, $5::"GameResourceStatus", $6::jsonb, $7, $8,
       CASE WHEN $5 = 'PUBLISHED' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
    [
      randomUUID(),
      ref.kind,
      ref.name,
      ref.version,
      config.draft ? 'DRAFT' : 'PUBLISHED',
      JSON.stringify(content),
      config.contentHash ?? hashState(content),
      'S3 시험 자원',
    ],
  );
}

function countingDb(db: PrismaClient) {
  let count = 0;
  const wrapper = {
    gameResource: {
      ...db.gameResource,
      findMany: (...args: Parameters<typeof db.gameResource.findMany>) => {
        count++;
        return db.gameResource.findMany(...args);
      },
    },
  } as Pick<PrismaClient, 'gameResource'>;
  return { db: wrapper, count: () => count };
}

it('P13 빈 표는 다섯 누락 키와 초기화 안내로 실패하고 파일을 읽지 않는다', async () => {
  await withDatabase(async ({ db }) => {
    await noFileFallback(async () => {
      const error = await loadInitialWorldFromDb(db, options).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      for (const ref of refs) expect(message).toContain(`${ref.kind}/${ref.name}/1`);
      expect(message).toContain('pnpm db:init-resources');
    });
  });
});

it('P14 없는 DB 접속 실패 뒤에도 파일을 읽지 않는다', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('전용 TEST_DATABASE_URL이 필요합니다.');
  const reference = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  const name = `resource_catalog_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(reference);
  url.pathname = `/${name}`;
  testDatabaseUrl({ TEST_DATABASE_URL: url.href, DATABASE_URL: process.env.DATABASE_URL });
  const adminUrl = new URL(reference);
  adminUrl.pathname = '/postgres';
  const admin = nativeClient(adminUrl.href);
  const db = createDb(url.href);
  await admin.connect();
  try {
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
    await noFileFallback(async () => {
      await expect(loadInitialWorldFromDb(db, options)).rejects.toThrow();
    });
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
  } finally {
    await db.$disconnect();
    await admin.end();
  }
});

it('P14 자원 migration 전 DB는 실패하고 파일을 읽지 않는다', async () => {
  await withDatabase(
    async ({ db }) => {
      await noFileFallback(async () => {
        await expect(loadInitialWorldFromDb(db, options)).rejects.toThrow();
      });
    },
    { beforeCatalog: true },
  );
});

it('P15 없는 2판은 키를 적어 거부한다', async () => {
  await expect(readPublishedResources(sharedDb(), [{ kind: 'MAP', name: 'che', version: 2 }])).rejects.toThrow(
    'MAP/che/2',
  );
});

it('P15 실제 게시 2판을 정확히 읽고 정규형 키로 월드를 합성한다', async () => {
  await withDatabase(
    async (fixture) => {
      const resources = await readInitialResources(fixture.db, options);
      await insertResource(fixture, { kind: 'MAP', name: 'che', version: 2 }, resources.map.content);
      const [map] = await readPublishedResources(fixture.db, [{ kind: 'MAP', name: 'che', version: 2 }]);
      expect(map!.version).toBe(2);
      await noFileFallback(async () => {
        expect(composeInitialWorld({ ...resources, map: map! }, options.seed)).toEqual({
          ...composeInitialWorld(resources, options.seed),
          mapKey: 'che@2',
        });
      }, 2);
    },
    { initialize: true },
  );
});

it.each([false, true])('AC-P2-27 게시 2판 CLI 생성·출처·초기화·재생을 보존한다 (published=%s)', async (published) => {
  await withDatabase(
    async (fixture) => {
      const original = await readInitialResources(fixture.db, options);
      for (const row of Object.values(original))
        await insertResource(fixture, { kind: row.kind, name: row.name, version: 2 }, row.content);
      const output = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'apps/engine/src/cli/createWorld.ts',
          ...(published ? ['--published'] : []),
          '--map',
          'che@2',
          '--scenario',
          '1030@2',
          '--unit-set',
          'basic@2',
          '--stat-rules',
          'default@2',
          '--portrait-map',
          'rtk14-map@2',
          '--seed',
          't479-original',
          '--turn-term',
          '30',
          '--end-year',
          '300',
          '--name',
          'AC-P2-27 게시 2판',
        ],
        {
          cwd: new URL('../', import.meta.url),
          env: { ...process.env, DATABASE_URL: fixture.url },
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      const { worldId } = JSON.parse(output.trim()) as { worldId: string };
      const world = await fixture.db.world.findUniqueOrThrow({ where: { id: worldId } });
      expect(world).toMatchObject({ mapKey: 'che@2', scenarioKey: '1030@2', unitSetKey: 'basic@2' });
      expect(await scenarioTitle('1030@2', fixture.db)).toBe((original.scenario.content as { title: string }).title);
      const audit = await fixture.db.auditLog.findFirstOrThrow({
        where: { worldId, actorKind: 'CLI', action: 'world.create.applied' },
      });
      const payload = audit.payload as {
        stateHash: string;
        resources: Array<{ kind: string; name: string; version: number; contentHash: string }>;
      };
      expect(payload.stateHash).toBe(world.initialStateHash);
      expect(payload.resources).toHaveLength(5);
      expect(payload.resources.every((row) => row.version === 2)).toBe(true);
      await controlClock(fixture.db, worldId, 'start');
      const lease = await acquireLease(fixture.db, worldId);
      if (!lease) throw new Error('2판 월드의 실행권이 필요합니다.');
      try {
        const loop = new TurnLoop(fixture.db, lease);
        for (let tick = 1_000; tick <= TICKS_PER_MONTH; tick += 1_000) {
          await renewLease(fixture.db, lease);
          await loop.advanceTo(tick);
        }
      } finally {
        await releaseLease(fixture.db, lease);
      }
      await controlClock(fixture.db, worldId, 'pause');
      const archive = await exportReplay(fixture.db, worldId);
      expect(archive.origin.initial.mapKey).toBe('che@2');
      expect(archive.months).toHaveLength(1);
      const replayEnv = { ...process.env };
      delete replayEnv.DATABASE_URL;
      delete replayEnv.TEST_DATABASE_URL;
      const replayed = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          "import {readFileSync} from 'node:fs'; import {replayArchive} from './apps/engine/src/replay.ts'; process.stdout.write(JSON.stringify(replayArchive(JSON.parse(readFileSync(0,'utf8')),1)));",
        ],
        {
          cwd: new URL('../', import.meta.url),
          env: replayEnv,
          input: JSON.stringify(archive),
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      expect(JSON.parse(replayed)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
      const signal = new AbortController().signal;
      const candidate = await prepareWorldReset(fixture.db, worldId, 't479-next', signal);
      expect(candidate.evidence.resources).toEqual(payload.resources);
      expect(candidate.evidence.provenance).toEqual({ kind: 'cli' });
      const next = await fixture.db.$transaction(async (tx) => {
        const current = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        await verifyResetPreparation(tx, current, candidate, 't479-next', signal);
        return savePreparedInitialWorld(tx, candidate.prepared);
      });
      expect(await fixture.db.world.findUniqueOrThrow({ where: { id: next.worldId } })).toMatchObject({
        seed: 't479-next',
        mapKey: 'che@2',
        scenarioKey: '1030@2',
        unitSetKey: 'basic@2',
      });
      await expect(prepareWorldReset(fixture.db, next.worldId, 'missing', signal)).rejects.toMatchObject({
        code: 'PROVENANCE_INVALID',
      });
      await fixture.db.auditLog.create({
        data: {
          actorKind: 'CLI',
          action: 'world.create.applied',
          targetType: 'World',
          targetId: next.worldId,
          worldId: next.worldId,
          payload: { ...payload, stateHash: '0'.repeat(64) },
        },
      });
      await expect(prepareWorldReset(fixture.db, next.worldId, 'tampered', signal)).rejects.toMatchObject({
        code: 'PROVENANCE_INVALID',
      });
    },
    { initialize: true },
  );
});

it('P15 다른 kind를 넣은 칸은 build 전에 키를 적어 거부한다', async () => {
  const resources = await readInitialResources(sharedDb(), options);
  await noFileFallback(async () => {
    expect(() => composeInitialWorld({ ...resources, map: resources.scenario }, options.seed)).toThrow(
      'SCENARIO/1030/1',
    );
  });
});

it('P16 DRAFT만 있는 키는 게시 자원 없음으로 거부한다', async () => {
  await withDatabase(async (fixture) => {
    const resources = await readInitialResources(sharedDb(), options);
    await insertResource(fixture, refs[0]!, resources.map.content, { draft: true });
    await expect(readPublishedResources(fixture.db, [refs[0]!])).rejects.toThrow('MAP/che/1');
  });
});

it('P17 게시 내용의 저장 해시가 틀리면 키를 적어 거부한다', async () => {
  await withDatabase(
    async (fixture) => {
      const resources = await readInitialResources(fixture.db, options);
      const ref: GameResourceRef = { kind: 'MAP', name: 's3_bad_hash', version: 1 };
      await insertResource(fixture, ref, resources.map.content, { contentHash: '0'.repeat(64) });
      await expect(readPublishedResources(fixture.db, [ref])).rejects.toThrow('MAP/s3_bad_hash/1');
    },
    { initialize: true },
  );
});

it.each([
  ['MAP', 'map'],
  ['SCENARIO', 'scenario'],
  ['UNIT_SET', 'unitSet'],
] as const)('P18 %s 내용 id와 이름이 다르면 build 전에 거부한다', async (kind, slot) => {
  await withDatabase(
    async (fixture) => {
      const resources = await readInitialResources(fixture.db, options);
      await insertResource(fixture, { kind, name: 's3_id_mismatch', version: 1 }, resources[slot].content);
      await noFileFallback(async () => {
        await expect(loadInitialWorldFromDb(fixture.db, { ...options, [slot]: 's3_id_mismatch' })).rejects.toThrow(
          `${kind}/s3_id_mismatch/1`,
        );
      });
    },
    { initialize: true },
  );
});

it.each([
  ['MAP', 'map', 0],
  ['STAT_RULES', 'statRules', 1],
] as const)('P19 %s 빈 내용은 키를 적어 합성에 실패한다', async (kind, slot, builds) => {
  await withDatabase(
    async (fixture) => {
      const resources = await readInitialResources(fixture.db, options);
      const ref = { kind, name: 's3_empty', version: 1 };
      await insertResource(fixture, ref, {});
      const [resource] = await readPublishedResources(fixture.db, [ref]);
      await noFileFallback(async () => {
        expect(() => composeInitialWorld({ ...resources, [slot]: resource! }, options.seed)).toThrow(
          `${kind}/s3_empty/1`,
        );
      }, builds);
    },
    { initialize: true },
  );
});

it.each([
  ['scenario', '../1030'],
  ['map', '/che'],
  ['unitSet', ''],
] as const)('P20 잘못된 %s 이름은 조회 전에 거부한다', async (slot, value) => {
  const counter = countingDb(sharedDb());
  await expect(readInitialResources(counter.db, { ...options, [slot]: value })).rejects.toThrow();
  expect(counter.count()).toBe(0);
});

it.each([0, -1, 1.5])('P20 판 번호 %s는 조회 전에 거부한다', async (version) => {
  const counter = countingDb(sharedDb());
  await expect(readPublishedResources(counter.db, [{ kind: 'MAP', name: 'che', version }])).rejects.toThrow();
  expect(counter.count()).toBe(0);
});

function resourceCli(fixture: Fixture, script: string, args: string[] = []) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: fixture.url },
    encoding: 'utf8',
    windowsHide: true,
  });
}

const s5CreateArgs = [
  '--scenario',
  '1030',
  '--map',
  'che',
  '--seed',
  'loader',
  '--turn-term',
  '30',
  '--end-year',
  '300',
  '--name',
  'DB 기본 생성',
];

it('T4-77 S5 기본 CLI는 S0 해시와 정확한 게시 판의 감사 출처를 보존한다', async () => {
  await withDatabase(
    async (fixture) => {
      const resources = await readInitialResources(fixture.db, options);
      const result = resourceCli(fixture, 'apps/engine/src/cli/createWorld.ts', s5CreateArgs);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const { worldId } = JSON.parse(result.stdout) as { worldId: string };
      const world = await fixture.db.world.findUniqueOrThrow({ where: { id: worldId } });
      expect(world).toMatchObject({
        mapKey: 'che',
        scenarioKey: '1030',
        unitSetKey: 'basic',
        initialStateHash: baseline.seeds.loader.initialStateHash,
      });
      const audit = await fixture.db.auditLog.findFirstOrThrow({
        where: { worldId, actorKind: 'CLI', action: 'world.create.applied' },
      });
      expect(audit.payload).toMatchObject({
        stateHash: world.initialStateHash,
        resources: Object.values(resources)
          .map(({ kind, name, version, contentHash }) => ({ kind, name, version, contentHash }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
      });
    },
    { initialize: true },
  );
});

it('T4-77 S5 기본 CLI는 게시 자원이 없으면 파일 대체·쓰기 없이 실패한다', async () => {
  await withDatabase(async (fixture) => {
    const before = await Promise.all([
      fixture.db.world.count(),
      fixture.db.auditLog.count(),
      fixture.db.gameResource.count(),
    ]);
    const result = resourceCli(fixture, 'apps/engine/src/cli/createWorld.ts', s5CreateArgs);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MAP/che/1');
    expect(result.stdout).toBe('');
    expect(
      await Promise.all([fixture.db.world.count(), fixture.db.auditLog.count(), fixture.db.gameResource.count()]),
    ).toEqual(before);
  });
});

it('T4-77 S5 로비는 누락 실패를 캐시하지 않고 잘못된 게시 내용의 오류를 가린다', async () => {
  await withDatabase(async (fixture) => {
    await expect(scenarioTitle('s5_title', fixture.db)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    await insertResource(
      fixture,
      { kind: 'SCENARIO', name: 's5_title', version: 1 },
      { id: 's5_title', title: '새 게시 제목' },
    );
    expect(await scenarioTitle('s5_title', fixture.db)).toBe('새 게시 제목');
    const contents: unknown[] = ['not-json', { id: 'other', title: '잘못된 번호' }, { title: '' }, { title: null }, {}];
    for (const [index, content] of contents.entries()) {
      const name = `s5_badtitle_${index}`;
      const value = typeof content === 'object' && content !== null ? { id: name, ...content } : content;
      await insertResource(fixture, { kind: 'SCENARIO', name, version: 1 }, value);
      const error = await scenarioTitle(name, fixture.db).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'INTERNAL_SERVER_ERROR' });
      expect(String(error)).not.toContain(name);
      expect(error).toHaveProperty('cause', undefined);
    }
  });
});

it('T4-77 S5 초상 도구는 게시 대응표와 비교하고 원본·게시 행을 바꾸지 않는다', async () => {
  await withDatabase(
    async (fixture) => {
      const originalPath = new URL(Object.keys(baseline.resources)[4]!, root);
      await expect(readFile(originalPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const before = await fixture.db.gameResource.findMany({ orderBy: { id: 'asc' } });
      const result = resourceCli(fixture, 'tools/portrait-map/generate.ts');
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('초상 대응:');
      expect(result.stdout).toContain('동명이인');
      expect(result.stdout).toContain('미대응');
      expect(result.stdout).toContain('게시 대응표 rtk14-map@1과 같습니다.');
      await expect(readFile(originalPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fixture.db.gameResource.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    },
    { initialize: true },
  );
});

it('T4-77 S5 초상 도구는 다른 게시 대응표를 수정하지 않고 실패한다', async () => {
  const resources = await readInitialResources(sharedDb(), options);
  await withDatabase(async (fixture) => {
    await insertResource(fixture, { kind: 'SCENARIO', name: '1030', version: 1 }, resources.scenario.content);
    await insertResource(
      fixture,
      { kind: 'PORTRAIT_MAP', name: 'rtk14-map', version: 1 },
      {
        ...(resources.portraitMap.content as Record<string, unknown>),
        $comment: '다른 게시 내용',
      },
    );
    const before = await fixture.db.gameResource.findMany({ orderBy: { id: 'asc' } });
    const result = resourceCli(fixture, 'tools/portrait-map/generate.ts');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('게시 대응표 rtk14-map@1과 다릅니다.');
    expect(await fixture.db.gameResource.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
});

it('T4-77 S5 초상 도구는 게시 자원이 없으면 원본 파일로 대체하지 않는다', async () => {
  await withDatabase(async (fixture) => {
    const result = resourceCli(fixture, 'tools/portrait-map/generate.ts');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SCENARIO/1030/1');
    expect(result.stderr).toContain('PORTRAIT_MAP/rtk14-map/1');
    expect(await fixture.db.gameResource.count()).toBe(0);
  });
});

it('T4-77 S6 시뮬레이션 열 시드의 DB·파일 초기 상태가 같다', async () => {
  const resources = await readInitialResources(sharedDb(), options);
  for (const [index, { slot }] of RESOURCE_INPUTS.entries())
    expect(hashState(resources[slot].content)).toBe(Object.values(baseline.resources)[index]!.contentHash);
  for (let index = 1; index <= 10; index++) {
    const seed = String(index);
    const fromDb = composeInitialWorld(resources, seed);
    const fromSource = buildInitialWorld({
      map: resources.map.content,
      scenario: resources.scenario.content,
      unitSet: resources.unitSet.content,
      statRules: resources.statRules.content,
      portraitMap: resources.portraitMap.content,
      seed,
    });
    expect(fromDb).toEqual(fromSource);
    expect(hashState(fromDb)).toBe(hashState(fromSource));
    if (seed === '1') expect(hashState(fromDb)).toBe(baseline.seeds['1'].initialStateHash);
  }
});

it('T4-77 S6 실제 sim CLI의 다중·반복 시드는 파일 공급자의 짧은 실행과 같다', async () => {
  await withDatabase(
    async (fixture) => {
      const resources = await readInitialResources(fixture.db, options);
      const before = await fixture.db.gameResource.findMany({ orderBy: { id: 'asc' } });
      const initial = composeInitialWorld(resources, '1');
      for (const args of [
        ['--seeds', '2'],
        ['--seed', '1', '--repeat'],
      ]) {
        const result = resourceCli(fixture, 'tools/sim/cli.ts', [...args, '--max-year', String(initial.startYear)]);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const environment = JSON.parse(result.stderr.trim());
        expect(environment).toMatchObject({
          scenario: '1030',
          map: 'che',
          maxYear: initial.startYear,
          convergence: 'on',
        });
        expect(environment.resources).toEqual(
          Object.values(resources).map(({ kind, name, version, contentHash }) => ({
            kind,
            name,
            version,
            contentHash,
          })),
        );
        const rows = result.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as ReturnType<typeof simulateGame> & { repeat?: boolean });
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.seed)).toEqual(args.includes('--repeat') ? ['1', '1'] : ['1', '2']);
        for (const [index, row] of rows.entries()) {
          const { seconds, repeat, ...actual } = row;
          const { seconds: expectedSeconds, ...expected } = simulateGame(composeInitialWorld(resources, row.seed), {
            maxYear: initial.startYear,
          });
          expect(expectedSeconds).toBeGreaterThan(0);
          expect(seconds).toBeGreaterThan(0);
          expect(seconds).toBeLessThanOrEqual(900);
          expect(repeat).toBe(args.includes('--repeat') && index === 1 ? true : undefined);
          expect(actual).toEqual(expected);
        }
      }
      expect(await fixture.db.gameResource.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
      expect(await fixture.db.world.count()).toBe(0);
      expect(await fixture.db.auditLog.count()).toBe(0);
    },
    { initialize: true },
  );
});

it('T4-77 S6 sim은 게시 자원이 없으면 출력 파일과 DB 행을 만들지 않는다', async () => {
  const output = join(tmpdir(), `t477-s6-${randomUUID()}.jsonl`);
  try {
    await withDatabase(async (fixture) => {
      const result = resourceCli(fixture, 'tools/sim/cli.ts', ['--seed', '1', '--output', output]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('SCENARIO/1030/1');
      expect(result.stdout).toBe('');
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fixture.db.gameResource.count()).toBe(0);
      expect(await fixture.db.world.count()).toBe(0);
      expect(await fixture.db.auditLog.count()).toBe(0);
    });
  } finally {
    await rm(output, { force: true });
  }
});

for (const [seed, expected] of Object.entries(baseline.seeds)) {
  it(`P21 S0 시드 ${seed}의 DB·파일 합성과 두 해시가 같다`, async () => {
    const resources = await readInitialResources(sharedDb(), options);
    for (const [index, { slot }] of RESOURCE_INPUTS.entries())
      expect(hashState(resources[slot].content)).toBe(Object.values(baseline.resources)[index]!.contentHash);
    let fromDb: WorldInit | undefined;
    if (expected.inputResourceCount === 5) {
      await noFileFallback(async () => {
        fromDb = composeInitialWorld(resources, seed);
      }, 1);
    } else {
      fromDb = buildInitialWorld({
        map: resources.map.content,
        scenario: resources.scenario.content,
        unitSet: resources.unitSet.content,
        statRules: resources.statRules.content,
        seed,
      });
    }
    expect(hashState(fromDb)).toBe(expected.initialStateHash);
    expect(resourceHash(fromDb!)).toBe(expected.resourceHash);
  });
}

it('P22 자원 초기화와 추가 게시 뒤에도 기존 월드·도시·생성 기록·재생 결과가 같다', async () => {
  await withDatabase(async (fixture) => {
    const initial = composeInitialWorld(await readInitialResources(sharedDb(), options), 'engine-test');
    expect(hashState(initial)).toBe(baseline.seeds['engine-test'].initialStateHash);
    const { worldId } = await saveInitialWorld(fixture.db, initial, {
      name: '자원 카탈로그 대조',
      turnTermMinutes: 60,
      endYear: null,
      replayFormat: 'legacy',
    });
    await controlClock(fixture.db, worldId, 'start');
    const lease = await acquireLease(fixture.db, worldId);
    if (!lease) throw new Error('재생 대조 월드의 리스를 얻지 못했습니다.');
    try {
      const loop = new TurnLoop(fixture.db, lease);
      for (let tick = 1_000; tick <= TICKS_PER_MONTH; tick += 1_000) {
        await renewLease(fixture.db, lease);
        await loop.advanceTo(tick);
      }
    } finally {
      await releaseLease(fixture.db, lease);
    }
    const snapshot = async () => {
      const archive = await exportReplay(fixture.db, worldId);
      return {
        world: (await fixture.native.query('SELECT to_jsonb(w) AS row FROM "World" w WHERE id = $1', [worldId])).rows,
        cities: (
          await fixture.native.query(
            'SELECT to_jsonb(c) AS row FROM "City" c WHERE "worldId" = $1 ORDER BY "cityKey"',
            [worldId],
          )
        ).rows,
        archive,
        replay: replayArchive(archive, 1),
      };
    };
    const before = await snapshot();
    expect(before.replay).toHaveLength(1);
    await initializeResources(fixture.db, fixture.sql);
    const resources = await readInitialResources(fixture.db, options);
    await insertResource(fixture, { kind: 'MAP', name: 's3_extra', version: 1 }, resources.map.content);
    expect(await snapshot()).toEqual(before);
  });
});

it('C9 DB와 원본 다섯 내용의 검증 보고가 같고 pass다', async () => {
  const resources = await readInitialResources(sharedDb(), options);
  for (const [index, { slot }] of RESOURCE_INPUTS.entries())
    expect(hashState(resources[slot].content)).toBe(Object.values(baseline.resources)[index]!.contentHash);
  const input = {
    map: resources.map.content,
    scenario: resources.scenario.content,
    unitSet: resources.unitSet.content,
    statRules: resources.statRules.content,
    portraitMap: resources.portraitMap.content,
  };
  const report = validateWorldResources(input);
  expect(report.status).toBe('pass');
});

it('C5 한 번 조회해 refs 순서로 돌려주고 transaction client도 받는다', async () => {
  const shuffled = [refs[4]!, refs[1]!, refs[3]!, refs[0]!, refs[2]!];
  const counter = countingDb(sharedDb());
  const rows = await readPublishedResources(counter.db, shuffled);
  expect(counter.count()).toBe(1);
  expect(rows.map(({ kind, name, version }) => ({ kind, name, version }))).toEqual(shuffled);
  expect(await sharedDb().$transaction((tx) => readPublishedResources(tx, shuffled))).toEqual(rows);
});

async function createDraft(db: PrismaClient) {
  const name = `a2_${randomUUID().replaceAll('-', '')}`;
  const content = { id: name, value: 0 };
  return db.gameResource.create({
    data: {
      kind: 'MAP',
      name,
      version: 2,
      status: 'DRAFT',
      content,
      contentHash: hashState(content),
      source: 'A2 시험',
    },
  });
}

it('A2 초안 저장은 revision과 편집자를 남기고 게시는 저장한 내용·revision을 유지한다', async () => {
  await withDatabase(async ({ db }) => {
    const draft = await createDraft(db);
    expect([draft.revision, draft.updatedBy, draft.updatedAt, draft.publishedBy]).toEqual([0, null, null, null]);
    const actor = randomUUID();
    const content = { id: draft.name, value: 1 };
    const saved = await db.gameResource.update({
      where: { id: draft.id },
      data: {
        content,
        contentHash: hashState(content),
        revision: { increment: 1 },
        updatedBy: actor,
        updatedAt: new Date(),
      },
    });
    expect(saved.revision).toBe(1);
    expect(saved.updatedBy).toBe(actor);
    expect(saved.updatedAt).not.toBeNull();
    const published = await db.gameResource.update({
      where: { id: draft.id },
      data: { status: 'PUBLISHED', publishedAt: new Date(), publishedBy: actor },
    });
    expect(published).toEqual({ ...saved, status: 'PUBLISHED', publishedAt: expect.any(Date), publishedBy: actor });
    expect(published.contentHash).toBe(hashState(published.content));
  });
});

it.each([
  ['id', { id: 'changed-id' }],
  ['kind', { kind: 'SCENARIO' }],
  ['name', { name: 'changed-name' }],
  ['version', { version: 3 }],
  ['createdBy', { createdBy: 'changed-creator' }],
  ['createdAt', { createdAt: new Date(0) }],
  ['source', { source: 'changed-source' }],
] as const)('A2 초안의 %s 식별 정보 변경은 거부하고 원래 행을 보존한다', async (_field, change) => {
  await withDatabase(async ({ db }) => {
    const draft = await createDraft(db);
    await expect(
      db.gameResource.update({ where: { id: draft.id }, data: { ...change, revision: { increment: 1 } } }),
    ).rejects.toThrow('Draft game resource identity');
    expect(await db.gameResource.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(draft);
  });
});

it.each([-1, 0, 2])('A2 저장 revision을 %i로 건너뛰거나 재사용하지 못한다', async (revision) => {
  await withDatabase(async ({ db }) => {
    const draft = await createDraft(db);
    await expect(db.gameResource.update({ where: { id: draft.id }, data: { revision } })).rejects.toThrow(
      'revision must increase by one',
    );
    expect(await db.gameResource.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(draft);
  });
});

it.each([
  ['revision', { revision: 1 }],
  ['content', { content: { id: 'unsaved' } }],
  ['contentHash', { contentHash: '0'.repeat(64) }],
] as const)('A2 게시하면서 저장된 %s를 바꾸지 못한다', async (_field, change) => {
  await withDatabase(async ({ db }) => {
    const draft = await createDraft(db);
    await expect(
      db.gameResource.update({
        where: { id: draft.id },
        data: { ...change, status: 'PUBLISHED', publishedAt: new Date() },
      }),
    ).rejects.toThrow('Publishing must preserve');
    expect(await db.gameResource.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(draft);
  });
});

it('A2 폐기 정책 전에는 초안을 삭제하지 못한다', async () => {
  await withDatabase(
    async ({ db }) => {
      const draft = await createDraft(db);
      await expect(db.gameResource.delete({ where: { id: draft.id } })).rejects.toThrow(
        'Draft game resources cannot be deleted',
      );
      expect(await db.gameResource.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(draft);
    },
    { beforeDiscard: true },
  );
});

it('AC-P2-27 D-071 migration 뒤에는 초안만 삭제할 수 있다', async () => {
  await withDatabase(async ({ db }) => {
    const draft = await createDraft(db);
    await db.gameResource.delete({ where: { id: draft.id } });
    expect(await db.gameResource.findUnique({ where: { id: draft.id } })).toBeNull();
  });
});

it('A2 게시 뒤에는 새 편집 메타데이터 갱신과 삭제도 거부한다', async () => {
  await withDatabase(async ({ db }) => {
    const draft = await createDraft(db);
    const published = await db.gameResource.update({
      where: { id: draft.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    await expect(
      db.gameResource.update({
        where: { id: draft.id },
        data: { revision: 1, updatedBy: randomUUID(), updatedAt: new Date() },
      }),
    ).rejects.toThrow('Published game resources cannot be updated or deleted');
    await expect(db.gameResource.delete({ where: { id: draft.id } })).rejects.toThrow(
      'Published game resources cannot be updated or deleted',
    );
    expect(await db.gameResource.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(published);
  });
});

it('A2 같은 revision의 실제 동시 저장은 하나만 성공하고 내용·해시가 그 결과와 일치한다', async () => {
  await withDatabase(async ({ db }) => {
    const draft = await createDraft(db);
    const results = await Promise.all(
      [1, 2].map((value) => {
        const content = { id: draft.name, value };
        return db.gameResource.updateMany({
          where: { id: draft.id, status: 'DRAFT', revision: 0 },
          data: { content, contentHash: hashState(content), revision: { increment: 1 } },
        });
      }),
    );
    expect(results.map(({ count }) => count).sort()).toEqual([0, 1]);
    const row = await db.gameResource.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.revision).toBe(1);
    expect(row.content).toEqual({ id: draft.name, value: results[0]!.count ? 1 : 2 });
    expect(row.contentHash).toBe(hashState(row.content));
  });
});

it('A2 저장과 게시가 겹치면 저장한 판 하나만 남고 이전 revision의 게시는 성공하지 않는다', async () => {
  await withDatabase(async ({ db }) => {
    const draft = await createDraft(db);
    const content = { id: draft.name, value: 1 };
    const [save, publish] = await Promise.all([
      db.gameResource.updateMany({
        where: { id: draft.id, status: 'DRAFT', revision: 0 },
        data: { content, contentHash: hashState(content), revision: { increment: 1 } },
      }),
      db.gameResource.updateMany({
        where: { id: draft.id, status: 'DRAFT', revision: 0 },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      }),
    ]);
    expect(save.count + publish.count).toBe(1);
    const row = await db.gameResource.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.status).toBe(save.count ? 'DRAFT' : 'PUBLISHED');
    expect(row.revision).toBe(save.count ? 1 : 0);
    expect(row.content).toEqual(save.count ? content : draft.content);
    expect(row.contentHash).toBe(hashState(row.content));
  });
});

it('A2 한 트랜잭션의 후속 식별 정보 오류는 앞선 정상 저장도 롤백한다', async () => {
  await withDatabase(async ({ db }) => {
    const draft = await createDraft(db);
    const content = { id: draft.name, value: 1 };
    await expect(
      db.$transaction(async (tx) => {
        await tx.gameResource.update({
          where: { id: draft.id },
          data: { content, contentHash: hashState(content), revision: 1 },
        });
        await tx.gameResource.update({ where: { id: draft.id }, data: { source: 'changed-source', revision: 2 } });
      }),
    ).rejects.toThrow('Draft game resource identity');
    expect(await db.gameResource.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(draft);
  });
});

it('A2 기존45개 migration의 게시·초안 행은 업그레이드 뒤 내용·해시·식별 정보를 보존한다', async () => {
  await withDatabase(
    async (fixture) => {
      for (const draft of [false, true]) {
        const name = draft ? 'a2_legacy_draft' : 'a2_legacy_published';
        await insertResource(fixture, { kind: 'MAP', name, version: 1 }, { id: name }, { draft });
      }
      const before = (await fixture.native.query('SELECT * FROM "GameResource" ORDER BY id')).rows;
      await fixture.native.query(await readFile(new URL(`${draftMigration}/migration.sql`, migrationRoot), 'utf8'));
      const after = (await fixture.native.query('SELECT * FROM "GameResource" ORDER BY id')).rows;
      expect(
        after.map(({ revision, updatedBy, updatedAt, publishedBy, ...row }) => {
          expect([revision, updatedBy, updatedAt, publishedBy]).toEqual([0, null, null, null]);
          return row;
        }),
      ).toEqual(before);
    },
    { beforeDrafts: true },
  );
});

it('Q78-4 같은 자원의 두 번째 초안은 거부하고 다른 종류·이름과 다음 게시 판은 허용한다', async () => {
  await withDatabase(async (fixture) => {
    const draft = await createDraft(fixture.db);
    const next = { kind: draft.kind, name: draft.name, version: draft.version + 1 };
    await expect(insertResource(fixture, next, draft.content, { draft: true })).rejects.toMatchObject({
      code: '23505',
      constraint: 'GameResource_one_draft_per_name_key',
    });
    expect(await fixture.db.gameResource.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(draft);
    await insertResource(fixture, { ...next, kind: 'SCENARIO' }, draft.content, { draft: true });
    await insertResource(fixture, { ...next, name: `${draft.name}_other` }, draft.content, { draft: true });
    await fixture.db.gameResource.update({
      where: { id: draft.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    await insertResource(fixture, next, draft.content, { draft: true });
    const rows = await fixture.db.gameResource.findMany({
      where: { kind: draft.kind, name: draft.name },
      orderBy: { version: 'asc' },
    });
    expect(rows.map(({ status, version }) => ({ status, version }))).toEqual([
      { status: 'PUBLISHED', version: 2 },
      { status: 'DRAFT', version: 3 },
    ]);
  });
});

it('Q78-4 다른 판 번호로 동시 생성해도 같은 자원의 초안은 하나만 생긴다', async () => {
  await withDatabase(async ({ db }) => {
    const name = `single_${randomUUID().replaceAll('-', '')}`;
    const content = { id: name };
    const results = await Promise.allSettled(
      [2, 3].map((version) =>
        db.gameResource.create({
          data: {
            kind: 'MAP',
            name,
            version,
            status: 'DRAFT',
            content,
            contentHash: hashState(content),
            source: 'Q78-4',
          },
        }),
      ),
    );
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: { code: 'P2002' },
    });
    const saved = await db.gameResource.findMany({ where: { kind: 'MAP', name, status: 'DRAFT' } });
    expect(saved).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled');
    expect(winner?.status === 'fulfilled' && winner.value).toEqual(saved[0]);
  });
});

it('Q78-4 색인 추가는 기존 게시 판들과 한 초안을 그대로 보존한다', async () => {
  await withDatabase(
    async (fixture) => {
      const name = 'single_draft_upgrade';
      for (const version of [1, 2, 3]) {
        await insertResource(fixture, { kind: 'MAP', name, version }, { id: name, version }, { draft: version === 3 });
      }
      const before = (await fixture.native.query('SELECT * FROM "GameResource" ORDER BY id')).rows;
      await fixture.native.query(
        await readFile(new URL(`${singleDraftMigration}/migration.sql`, migrationRoot), 'utf8'),
      );
      expect((await fixture.native.query('SELECT * FROM "GameResource" ORDER BY id')).rows).toEqual(before);
      const indexes = await fixture.native.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'GameResource_one_draft_per_name_key'`,
      );
      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0]!.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(indexes.rows[0]!.indexdef).toContain('(kind, name)');
      expect(indexes.rows[0]!.indexdef).toContain(`WHERE (status = 'DRAFT'::"GameResourceStatus")`);
    },
    { beforeSingleDraft: true },
  );
});

it('Q78-4 기존 중복 초안이 있으면 삭제·선택 없이 색인 추가 전체를 거부한다', async () => {
  await withDatabase(
    async (fixture) => {
      const name = 'single_draft_conflict';
      for (const version of [2, 3]) {
        await insertResource(fixture, { kind: 'MAP', name, version }, { id: name, version }, { draft: true });
      }
      const before = (await fixture.native.query('SELECT * FROM "GameResource" ORDER BY id')).rows;
      await expect(
        fixture.native.query(await readFile(new URL(`${singleDraftMigration}/migration.sql`, migrationRoot), 'utf8')),
      ).rejects.toMatchObject({ code: '23505' });
      await fixture.native.query('ROLLBACK');
      expect((await fixture.native.query('SELECT * FROM "GameResource" ORDER BY id')).rows).toEqual(before);
      expect(
        (await fixture.native.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'GameResource_one_draft_per_name_key'`))
          .rows,
      ).toEqual([]);
    },
    { beforeSingleDraft: true },
  );
});

it('A3 조회는 내장 다섯 종류를 읽고 읽기 전용 트랜잭션에서 자원·감사·게임 표를 보존한다', async () => {
  await withDatabase(
    async ({ db, native }) => {
      const snapshot = async () => ({
        resources: await db.gameResource.findMany({ orderBy: { id: 'asc' } }),
        audit: await db.auditLog.findMany({ orderBy: { id: 'asc' } }),
        game: await Promise.all([
          db.world.count(),
          db.city.count(),
          db.general.count(),
          db.generalTurn.count(),
          db.inputEvent.count(),
        ]),
      });
      const before = await snapshot();
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const page = await listResources(tx, {}, RESOURCE_PAYLOAD_LIMITS);
        expect(page.items).toHaveLength(5);
        expect(page.next).toBeNull();
        expect(new Set(page.items.map((item) => item.kind))).toEqual(new Set(refs.map((ref) => ref.kind)));
        for (const meta of page.items) {
          expect(meta).not.toHaveProperty('content');
          expect(meta).not.toHaveProperty('report');
          const result = await getResource(tx, meta.id, RESOURCE_PAYLOAD_LIMITS);
          expect(result.meta).toEqual(meta);
          expect(result.content).toEqual(before.resources.find((row) => row.id === meta.id)!.content);
          expect(result.meta.contentHash).toBe(hashState(result.content));
          const measured = await native.query<{ bytes: number }>(
            'SELECT octet_length(convert_to(content::text, \'UTF8\')) AS bytes FROM "GameResource" WHERE id=$1',
            [meta.id],
          );
          expect(meta.contentBytes).toBe(measured.rows[0]!.bytes);
        }
      });
      expect(await snapshot()).toEqual(before);
    },
    { initialize: true },
  );
});

it('A3 조회는 50행 커서와 같은 필터로 빠짐없이 이어 읽고 마지막 next를 비운다', async () => {
  await withDatabase(async ({ db }) => {
    const rows = Array.from({ length: 55 }, (_, index) => ({
      id: randomUUID(),
      kind: 'MAP' as const,
      name: `a3_page_${index}`,
      version: 2,
      status: 'DRAFT' as const,
      content: { index },
      contentHash: hashState({ index }),
      source: 'A3 시험',
    }));
    await db.gameResource.createMany({ data: rows });
    await db.gameResource.create({
      data: {
        kind: 'UNIT_SET',
        name: 'a3_other',
        version: 1,
        status: 'PUBLISHED',
        content: {},
        contentHash: hashState({}),
        source: 'A3 시험',
        publishedAt: new Date(),
      },
    });
    const filter = { kind: 'MAP' as const, status: 'DRAFT' as const };
    const first = await listResources(db, filter, RESOURCE_PAYLOAD_LIMITS);
    expect(first.items).toHaveLength(50);
    expect(first.next).toBeTypeOf('string');
    const second = await listResources(db, { ...filter, cursor: first.next! }, RESOURCE_PAYLOAD_LIMITS);
    expect(second.items).toHaveLength(5);
    expect(second.next).toBeNull();
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(rows.map((row) => row.id).sort());
    expect(
      (await listResources(db, { name: rows[0]!.name }, RESOURCE_PAYLOAD_LIMITS)).items.map((item) => item.id),
    ).toEqual([rows[0]!.id]);
    expect(await listResources(db, { name: 'a3_missing' }, RESOURCE_PAYLOAD_LIMITS)).toEqual({ items: [], next: null });
  });
});

it('A3 조회는 next까지 응답 예산에 세어 쪽을 나누고 커서가 매번 진행한다', async () => {
  await withDatabase(async ({ db }) => {
    const content = {};
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: randomUUID(),
      kind: 'MAP' as const,
      name: `a3_bytes_${index}`,
      version: 2,
      status: 'DRAFT' as const,
      content,
      contentHash: hashState(content),
      source: 'x'.repeat(200),
    }));
    await db.gameResource.createMany({ data: rows });
    const limits = makeLimits({ depthMax: 16, contentMax: 1024, metaMax: 1024, responseMax: 2300 });
    const found: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const page = await listResources(db, cursor === undefined ? {} : { cursor }, limits);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(limits.responseMax);
      expect(page.items.length).toBeGreaterThan(0);
      found.push(...page.items.map((item) => item.id));
      if (page.next === null) break;
      expect(cursors.has(page.next)).toBe(false);
      cursors.add(page.next);
      cursor = page.next;
    }
    expect(cursors.size).toBeGreaterThan(0);
    expect(found).toEqual(rows.map((row) => row.id).sort());
  });
});

it('A3 조회는 Meta 하나가 들어가도 next를 담지 못하면 빈 쪽을 반복하지 않고 실패한다', async () => {
  await withDatabase(async ({ db }) => {
    const content = {};
    const common = {
      kind: 'MAP' as const,
      version: 2,
      status: 'DRAFT' as const,
      content,
      contentHash: hashState(content),
    };
    const reference = await db.gameResource.create({
      data: {
        ...common,
        id: '00000000-0000-4000-8000-000000000002',
        name: 'a3_budget_b',
        source: 'x',
      },
    });
    const base = (await getResource(db, reference.id, RESOURCE_PAYLOAD_LIMITS)).meta;
    const source = 'x'.repeat(1 + 1024 - Buffer.byteLength(JSON.stringify(base)));
    const first = await db.gameResource.create({
      data: {
        ...common,
        id: '00000000-0000-4000-8000-000000000001',
        name: 'a3_budget_a',
        source,
      },
    });
    const meta = (await getResource(db, first.id, RESOURCE_PAYLOAD_LIMITS)).meta;
    expect(Buffer.byteLength(JSON.stringify(meta))).toBe(1024);
    const limits = makeLimits({ depthMax: 16, contentMax: 2, metaMax: 1024, responseMax: 1090 });
    await expect(listResources(db, {}, limits)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});

it('A3 조회는 초안·게시 메타데이터를 UTC로 돌려주고 비UTC 세션에서도 같다', async () => {
  await withDatabase(async ({ db }) => {
    const actor = randomUUID();
    const createdAt = new Date('2026-11-05T00:01:02.003Z');
    const updatedAt = new Date('2026-11-05T00:02:03.004Z');
    const publishedAt = new Date('2026-11-05T00:03:04.005Z');
    const draft = await db.gameResource.create({
      data: {
        kind: 'MAP',
        name: 'a3_dates',
        version: 2,
        status: 'DRAFT',
        content: { kept: ['한글', 1] },
        contentHash: hashState({ kept: ['한글', 1] }),
        source: 'UTF-8 자료',
        createdBy: actor,
        createdAt,
      },
    });
    expect((await getResource(db, draft.id, RESOURCE_PAYLOAD_LIMITS)).meta).toMatchObject({
      status: 'DRAFT',
      createdBy: actor,
      createdAt: createdAt.toISOString(),
      updatedBy: null,
      updatedAt: null,
      publishedBy: null,
      publishedAt: null,
    });
    await db.gameResource.update({ where: { id: draft.id }, data: { revision: 1, updatedBy: actor, updatedAt } });
    await db.gameResource.update({
      where: { id: draft.id },
      data: { status: 'PUBLISHED', publishedBy: actor, publishedAt },
    });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Seoul'`;
      const result = await getResource(tx, draft.id, RESOURCE_PAYLOAD_LIMITS);
      expect(result.content).toEqual(draft.content);
      expect(result.meta).toMatchObject({
        status: 'PUBLISHED',
        revision: 1,
        createdBy: actor,
        createdAt: createdAt.toISOString(),
        updatedBy: actor,
        updatedAt: updatedAt.toISOString(),
        publishedBy: actor,
        publishedAt: publishedAt.toISOString(),
      });
      expect((await listResources(tx, { name: draft.name }, RESOURCE_PAYLOAD_LIMITS)).items).toEqual([result.meta]);
    });
  });
});

it('A3 조회는 잘못된 UUID·커서·필터와 없는 행을 구분한다', async () => {
  await withDatabase(async ({ db }) => {
    await expect(getResource(db, 'private-marker', RESOURCE_PAYLOAD_LIMITS)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(getResource(db, randomUUID(), RESOURCE_PAYLOAD_LIMITS)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const id = randomUUID();
    for (const cursor of [
      '?',
      'x'.repeat(201),
      Buffer.from(`2:${id}`).toString('base64url'),
      Buffer.from('1:not-uuid').toString('base64url'),
      Buffer.from(`1:${id}`).toString('base64url') + '=',
    ]) {
      await expect(listResources(db, { cursor }, RESOURCE_PAYLOAD_LIMITS)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    await expect(listResources(db, { name: 'invalid/name' }, RESOURCE_PAYLOAD_LIMITS)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

it('A3 조회는 해시·깊이·compact 크기 오류에서 고정 내부 오류를 내고 원문을 노출하지 않는다', async () => {
  await withDatabase(async (fixture) => {
    const content = { privateMarker: 'hidden' };
    await insertResource(fixture, { kind: 'MAP', name: 'a3_bad_hash', version: 2 }, content, {
      draft: true,
      contentHash: 'a'.repeat(64),
    });
    let nested: Record<string, unknown> = {};
    for (let level = 0; level < 18; level++) nested = { nested };
    await insertResource(fixture, { kind: 'MAP', name: 'a3_depth', version: 2 }, nested, { draft: true });
    await insertResource(
      fixture,
      { kind: 'MAP', name: 'a3_compact', version: 2 },
      { text: 'x'.repeat(80) },
      { draft: true },
    );
    const before = await fixture.db.gameResource.findMany({ orderBy: { id: 'asc' } });
    for (const name of ['a3_bad_hash', 'a3_depth', 'a3_compact']) {
      const row = before.find((item) => item.name === name)!;
      const limits =
        name === 'a3_compact'
          ? makeLimits({ depthMax: 16, contentMax: 32, metaMax: 1024, responseMax: 1120 })
          : RESOURCE_PAYLOAD_LIMITS;
      await expect(getResource(fixture.db, row.id, limits)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: '자원 판을 읽을 수 없습니다.',
      });
    }
    expect(await fixture.db.gameResource.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await fixture.db.auditLog.count()).toBe(0);
  });
});

it('A3 조회는 큰 양·음 지수의 유한수를 보존하고 저장 텍스트 크기를 별도로 잰다', async () => {
  await withDatabase(async (fixture) => {
    const content = { large: 1e308, tiny: 5e-324 };
    await insertResource(fixture, { kind: 'MAP', name: 'a3_numbers', version: 2 }, content, { draft: true });
    const row = await fixture.db.gameResource.findFirstOrThrow({ where: { name: 'a3_numbers' } });
    const limits = makeLimits({ depthMax: 16, contentMax: 64, metaMax: 1024, responseMax: 1152 });
    const result = await getResource(fixture.db, row.id, limits);
    expect(result.content).toEqual(content);
    expect(result.meta.contentBytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(content)) * 2);
    expect((await listResources(fixture.db, {}, limits)).items).toEqual([result.meta]);
  });
});

it('A3 조회는 compact가 작아도 긴 소수 scale이 저장 전송 한도를 넘으면 거부한다', async () => {
  await withDatabase(async ({ db, native }) => {
    const id = randomUUID();
    await native.query(
      "INSERT INTO \"GameResource\" (id,kind,name,version,status,content,\"contentHash\",source) VALUES ($1,'MAP','a3_scale',2,'DRAFT',$2::jsonb,$3,'A3 시험')",
      [id, '{"n":1.' + '0'.repeat(2000) + '}', hashState({ n: 1 })],
    );
    const result = await getResource(db, id, RESOURCE_PAYLOAD_LIMITS);
    expect(result.content).toEqual({ n: 1 });
    expect(result.meta.contentBytes).toBeGreaterThan(8 * 64);
    const limits = makeLimits({ depthMax: 16, contentMax: 8, metaMax: 1024, responseMax: 1096 });
    await expect(getResource(db, id, limits)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((await listResources(db, {}, limits)).items).toEqual([result.meta]);
  });
});

it('A3 조회는 거대한 메타데이터와 JSON 이스케이프·잘못된 행위자·비정상 시각을 거부한다', async () => {
  await withDatabase(async ({ db, native }) => {
    const rows = [
      { name: 'a3_meta_big', source: 'x'.repeat(9000) },
      { name: 'a3_meta_escape', source: '\n'.repeat(250) },
      { name: 'a3_actor', source: 'A3 시험', createdBy: 'private-marker-not-uuid' },
    ];
    for (const row of rows)
      await db.gameResource.create({
        data: {
          ...row,
          kind: 'MAP',
          version: 2,
          status: 'DRAFT',
          content: {},
          contentHash: hashState({}),
        },
      });
    const infinityId = randomUUID();
    await native.query(
      "INSERT INTO \"GameResource\" (id,kind,name,version,status,content,\"contentHash\",source,\"createdAt\") VALUES ($1,'MAP','a3_time',2,'DRAFT','{}'::jsonb,$2,'A3 시험','infinity')",
      [infinityId, hashState({})],
    );
    const limits = makeLimits({ depthMax: 16, contentMax: 2, metaMax: 512, responseMax: 578 });
    for (const name of [...rows.map((row) => row.name), 'a3_time']) {
      const page = await db.gameResource.findFirstOrThrow({ where: { name }, select: { id: true } });
      await expect(getResource(db, page.id, limits)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: '자원 판을 읽을 수 없습니다.',
      });
      await expect(listResources(db, { name }, limits)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    }
  });
});

describe('T4-77 S2a 초기화 SQL', () => {
  async function converted() {
    const resources = await readInitialResources(sharedDb(), options);
    const expected = Object.values(baseline.resources);
    const input = Object.fromEntries(
      RESOURCE_INPUTS.map(({ slot }, index) => {
        const resource = resources[slot];
        expect(hashState(resource.content)).toBe(expected[index]!.contentHash);
        expect(resource.contentHash).toBe(expected[index]!.contentHash);
        return [slot, JSON.stringify(resource.content, null, 2)];
      }),
    ) as ResourceTexts;
    const notice = verifyInitialNotice(await readFile(new URL(INITIAL_NOTICE_FIXTURE, root), 'utf8'));
    const sql = convertResourcesToSql(input, notice);
    const contents = [...sql.matchAll(/resource_content := \$t4_77_content\$([\s\S]*?)\$t4_77_content\$::jsonb;/g)].map(
      (match) => match[1]!,
    );
    const changedMap = (value: unknown): ResourceTexts => ({ ...input, map: JSON.stringify(value) });
    return { input, notice, sql, contents, changedMap };
  }
  it('다섯 실제 원본은 검증기를 통과하고 원래 외교 경고 하나만 남는다', async () => {
    const { input } = await converted();
    const parsed = Object.fromEntries(Object.entries(input).map(([key, raw]) => [key, JSON.parse(raw)])) as Record<
      keyof ResourceTexts,
      unknown
    >;
    const report = validateWorldResources(parsed);
    expect(report.status).toBe('pass');
    expect(report.scenario.issues.map((issue) => issue.code)).toEqual(['scenario-diplomacy-duplicate']);
    for (const slot of ['map', 'unitSet', 'statRules', 'portraitMap'] as const) expect(report[slot].issues).toEqual([]);
  });

  it('원본과 NOTICE의 CRLF는 LF 입력과 같은 SQL을 만든다', async () => {
    const { input, sql, notice } = await converted();
    const crlf = Object.fromEntries(
      Object.entries(input).map(([key, raw]) => [key, raw.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')]),
    ) as ResourceTexts;
    expect(convertResourcesToSql(crlf, notice.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))).toBe(sql);
  });

  it('로더가 쓰지 않는 원본 칸도 SQL 내용에 남는다', async () => {
    const { contents } = await converted();
    expect(JSON.parse(contents[0]!)).toHaveProperty('meta');
    expect(JSON.parse(contents[1]!)).toHaveProperty('general_ex');
    expect(JSON.parse(contents[4]!)).toHaveProperty('ambiguous');
    for (const raw of contents) expect(JSON.parse(raw)).toHaveProperty('$comment');
  });

  it('검증기가 받는 원본이라도 추가 칸으로 S0 해시가 달라지면 거부한다', async () => {
    const { input, notice, changedMap } = await converted();
    const modified = { ...JSON.parse(input.map), s2aExtra: '내용을 바꾸지 않는다' };
    expect(() => convertResourcesToSql(changedMap(modified), notice)).toThrow('S0 해시 불일치: MAP/che/1');
  });

  it('실제 검증기의 fail은 SQL을 만들기 전에 거부한다', async () => {
    const { notice, changedMap } = await converted();
    expect(() => convertResourcesToSql(changedMap(null), notice)).toThrow('검증 실패: MAP/che/1');
  });

  it('MIT 전문과 초상 출처를 포함한 NOTICE 전체를 글자 그대로 옮긴다', async () => {
    const { sql, notice } = await converted();
    const commentedNotice = sql.slice(sql.indexOf('\n') + 1, sql.indexOf(`\n\nDO ${BODY_TAG}`));
    const restored = commentedNotice
      .split('\n')
      .map((line) => (line === '--' ? '' : line.slice(3)))
      .join('\n');
    expect(restored).toBe(notice.replaceAll('\r\n', '\n'));
    expect(restored).toContain('Copyright (c) 2025 devsam');
    expect(restored).toContain('## 초상 메타데이터와 한자 독음 표');
    expect(restored).not.toBe(notice.replace('2025 devsam', '2024 devsam').replaceAll('\r\n', '\n'));
  });

  it('다섯 source는 원 경로와 기존 출처 문구를 그대로 담는다', async () => {
    const { input, sql } = await converted();
    const expected = RESOURCE_INPUTS.map(
      (resource, index) => `${Object.keys(baseline.resources)[index]}; ${JSON.parse(input[resource.slot]).$comment}`,
    );
    for (const source of expected) expect(sql.split(`'${source}'`)).toHaveLength(3);
  });

  it('트랜잭션 명령 없는 단일 DO 안에서 다섯 삽입 뒤 각 행을 대조한다', async () => {
    const { sql, contents } = await converted();
    expect(contents).toHaveLength(5);
    const withoutContent = sql.replace(/\$t4_77_content\$[\s\S]*?\$t4_77_content\$/g, '').replace(/^--.*\n/gm, '');
    expect(withoutContent.match(/\bDO\b/g)).toHaveLength(6); // DO 문 하나와 DO NOTHING 다섯이다.
    expect(withoutContent.match(/ON CONFLICT \("kind", "name", "version"\) DO NOTHING;/g)).toHaveLength(5);
    expect(withoutContent.match(/IF NOT EXISTS \(/g)).toHaveLength(5);
    expect(withoutContent.match(/AND "content" = resource_content AND "contentHash" = '[0-9a-f]{64}'/g)).toHaveLength(
      5,
    );
    expect(withoutContent.match(/AND "status" = 'PUBLISHED' AND "source" = /g)).toHaveLength(5);
    expect(withoutContent).not.toMatch(/\b(COMMIT|ROLLBACK)\b|DO UPDATE/);
    const bodyStart = withoutContent.indexOf(`DO ${BODY_TAG}`);
    expect(withoutContent.slice(0, bodyStart).trim()).toBe('');
    expect(withoutContent).toContain(`END;\n${BODY_TAG};\n`);
    const errors = [...withoutContent.matchAll(/RAISE EXCEPTION '([^']+)';/g)].map((match) => match[1]);
    expect(errors).toEqual(RESOURCE_INPUTS.map((resource) => `초기화 자원 충돌: ${resource.kind}/${resource.name}/1`));
  });
});
