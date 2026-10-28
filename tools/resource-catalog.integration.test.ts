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

async function createFixture(config: { beforeCatalog?: boolean; initialize?: boolean } = {}): Promise<Fixture> {
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
    for (const migration of migrations.filter((entry) => !config.beforeCatalog || entry.name < targets[0]!.name)) {
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
  config: { beforeCatalog?: boolean; initialize?: boolean } = {},
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
