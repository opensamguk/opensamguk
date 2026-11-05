import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createDb, readPublishedResources, type GameResourceRef, type PrismaClient } from '../packages/db/src/index';
import { buildInitialWorld, TICKS_PER_MONTH, type WorldInit } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import {
  composeInitialWorld,
  loadInitialWorld,
  loadInitialWorldFromDb,
  readInitialResources,
  resourceRoot,
} from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { exportReplay, replayArchive, resourceHash } from '../apps/engine/src/replay';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { validateWorldResources } from '../packages/rules/src/world/validate/index';
import baseline from './fixtures/t4-77-baseline.json';
import { initializeResources } from './init-resources';
import { RESOURCE_INPUTS } from './resources-sql/convert';
import { testDatabaseUrl } from './test-database';
import { getResource, listResources } from '../apps/server/src/resourceAdmin/read';
import { makeLimits, RESOURCE_PAYLOAD_LIMITS } from '../apps/server/src/resourceAdmin/payload';

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
  native: PgClient;
  sql: string;
  dispose(): Promise<void>;
}

const draftMigration = '20261118000000_game_resource_draft_cas';
const singleDraftMigration = '20261119000000_game_resource_single_draft';

async function createFixture(
  config: { beforeCatalog?: boolean; beforeDrafts?: boolean; beforeSingleDraft?: boolean; initialize?: boolean } = {},
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
    return { db, native, sql, dispose };
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
  config: { beforeCatalog?: boolean; beforeDrafts?: boolean; beforeSingleDraft?: boolean; initialize?: boolean } = {},
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

it('P15 실제 게시 2판은 읽히지만 초기 월드 합성은 build 전에 거부한다', async () => {
  await withDatabase(
    async (fixture) => {
      const resources = await readInitialResources(fixture.db, options);
      await insertResource(fixture, { kind: 'MAP', name: 'che', version: 2 }, resources.map.content);
      const [map] = await readPublishedResources(fixture.db, [{ kind: 'MAP', name: 'che', version: 2 }]);
      expect(map!.version).toBe(2);
      await noFileFallback(async () => {
        expect(() => composeInitialWorld({ ...resources, map: map! }, options.seed)).toThrow('MAP/che/2');
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

for (const [seed, expected] of Object.entries(baseline.seeds)) {
  it(`P21 S0 시드 ${seed}의 DB·파일 합성과 두 해시가 같다`, async () => {
    const resources = await readInitialResources(sharedDb(), options);
    const fileContent = Object.fromEntries(
      await Promise.all(
        RESOURCE_INPUTS.map(async ({ slot, path }) => [slot, JSON.parse(await readFile(new URL(path, root), 'utf8'))]),
      ),
    );
    let fromDb: WorldInit | undefined;
    let fromFile: WorldInit;
    if (expected.inputResourceCount === 5) {
      await noFileFallback(async () => {
        fromDb = composeInitialWorld(resources, seed);
      }, 1);
      const fileStart = fileSpy.mock.calls.length;
      fromFile = await loadInitialWorld({ ...options, seed });
      expect(resourceReads(fileStart)).toHaveLength(5);
    } else {
      fromDb = buildInitialWorld({
        map: resources.map.content,
        scenario: resources.scenario.content,
        unitSet: resources.unitSet.content,
        statRules: resources.statRules.content,
        seed,
      });
      fromFile = buildInitialWorld({
        map: fileContent.map,
        scenario: fileContent.scenario,
        unitSet: fileContent.unitSet,
        statRules: fileContent.statRules,
        seed,
      });
    }
    expect(fromDb).toEqual(fromFile);
    expect(hashState(fromDb)).toBe(expected.initialStateHash);
    expect(hashState(fromFile)).toBe(expected.initialStateHash);
    expect(resourceHash(fromDb!)).toBe(expected.resourceHash);
  });
}

it('P22 자원 초기화와 추가 게시 뒤에도 기존 월드·도시·생성 기록·재생 결과가 같다', async () => {
  await withDatabase(async (fixture) => {
    const initial = await loadInitialWorld({ ...options, seed: 'engine-test' });
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
  const fileContent = Object.fromEntries(
    await Promise.all(
      RESOURCE_INPUTS.map(async ({ slot, path }) => [slot, JSON.parse(await readFile(new URL(path, root), 'utf8'))]),
    ),
  );
  const input = {
    map: resources.map.content,
    scenario: resources.scenario.content,
    unitSet: resources.unitSet.content,
    statRules: resources.statRules.content,
    portraitMap: resources.portraitMap.content,
  };
  const report = validateWorldResources(input);
  expect(report).toEqual(
    validateWorldResources({
      map: fileContent.map,
      scenario: fileContent.scenario,
      unitSet: fileContent.unitSet,
      statRules: fileContent.statRules,
      portraitMap: fileContent.portraitMap,
    }),
  );
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
  await withDatabase(async ({ db }) => {
    const draft = await createDraft(db);
    await expect(db.gameResource.delete({ where: { id: draft.id } })).rejects.toThrow(
      'Draft game resources cannot be deleted',
    );
    expect(await db.gameResource.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(draft);
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
