import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { createDb, type PrismaClient } from '../packages/db/src/index';
import { TICKS_PER_MONTH } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { loadInitialWorld, loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import fixture from './fixtures/t4-46-scenarios.json';
import { initializeResources } from './init-resources';
import { initializeScenarios, ScenarioInitializationError } from './init-scenarios';
import { pnpmCli } from './node-cli';
import { convertScenariosToSql, readyScenarioRows, scenarioRows } from './resources-sql/generate-scenarios';
import { testDatabaseUrl } from './test-database';

const root = new URL('../', import.meta.url);
const ready = fixture.scenarios.filter((row) => row.support === 'ready');
const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8')) as unknown;
const input = Object.fromEntries(
  await Promise.all(
    readyScenarioRows().map(async ({ key }) => [
      key,
      await readFile(new URL(`resources/scenario/${key}.json`, root), 'utf8'),
    ]),
  ),
);
const materials = {
  map: await read('resources/map/che.json'),
  unitSet: await read('resources/unitset/basic.json'),
  statRules: await read('resources/scenario/default.json'),
  portraitMap: await read('resources/portraits/rtk14-map.json'),
};
const notice = await readFile(new URL('resources/NOTICE.md', root), 'utf8');
const sql = await readFile(new URL('packages/db/sql/resources-scenarios.sql', root), 'utf8');
interface PgClient {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
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
  url: URL;
}

async function withDatabase(action: (value: Fixture) => Promise<void>, initialize = true): Promise<void> {
  if (!process.env.TEST_DATABASE_URL) throw new Error('전용 TEST_DATABASE_URL이 필요합니다.');
  const reference = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  const name = `scenarios_${randomUUID().replaceAll('-', '')}_test`;
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
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
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
    const migrations = new URL('packages/db/prisma/migrations/', root);
    const names = (await readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .sort();
    for (const name of names) await native.query(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
    db = createDb(url.href);
    if (initialize)
      await initializeResources(db, await readFile(new URL('packages/db/sql/resources-init.sql', root), 'utf8'));
    await action({ db, native, url });
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
    if (created && !oid) cleanupErrors.push(new Error('만든 DB의 OID가 없어 정리하지 않았습니다.'));
    if (created && oid) {
      try {
        expect((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [name])).rows).toEqual(
          [{ oid }],
        );
        expect(
          (await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1', [name])).rows,
        ).toEqual([{ count: 0 }]);
        await admin.query(`DROP DATABASE "${name}"`);
        expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      if (adminConnected) await admin.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failure && cleanupErrors.length)
    throw new AggregateError([failure, ...cleanupErrors], '시험과 자기 DB 정리가 실패했습니다.');
  if (failure) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '자기 DB 정리가 실패했습니다.');
}

async function allRows(native: PgClient) {
  return (await native.query('SELECT to_jsonb(g) AS row FROM "GameResource" g ORDER BY kind, name, version')).rows;
}
async function cli(url: URL) {
  const env = { ...process.env, DATABASE_URL: url.href, TEST_DATABASE_URL: url.href };
  const [executable, args] = pnpmCli(['db:init-scenarios']);
  const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

it('S5 CLI를 두 번 실행해도 새 판은 한 번만 들어가고 내장 다섯 판은 같다', async () => {
  await withDatabase(async ({ native, url }) => {
    const before = await allRows(native);
    const first = await cli(url);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain('시나리오 자원 저장: 삽입 9, 기존 0');
    const once = await allRows(native);
    const second = await cli(url);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain('시나리오 자원 저장: 삽입 0, 기존 9');
    expect(await allRows(native)).toEqual(once);
    expect(once).toHaveLength(14);
    for (const row of before) expect(once).toContainEqual(row);
  });
});

it('S5 내장 다섯 판이 없으면 시나리오를 넣기 전에 거부한다', async () => {
  await withDatabase(async ({ db, native }) => {
    await expect(initializeScenarios(db, sql)).rejects.toThrow('내장 자원 초기화를 먼저 실행하세요');
    expect(await allRows(native)).toEqual([]);
  }, false);
});

it.each(['content', 'contentHash', 'status', 'source'] as const)(
  'S5 마지막 키의 %s 충돌은 앞의 여덟 삽입도 롤백한다',
  async (field) => {
    await withDatabase(async ({ db, native }) => {
      const last = readyScenarioRows().at(-1)!;
      const content = JSON.parse(input[last.key]!);
      const conflict = {
        content,
        contentHash: last.contentHash!,
        status: 'PUBLISHED' as 'PUBLISHED' | 'DRAFT',
        source: last.source!,
      };
      if (field === 'content') conflict.content = { ...content, conflict: true };
      if (field === 'contentHash') conflict.contentHash = '0'.repeat(64);
      if (field === 'status') conflict.status = 'DRAFT';
      if (field === 'source') conflict.source = '다른 출처';
      await db.gameResource.create({
        data: {
          kind: 'SCENARIO',
          name: last.key,
          version: 1,
          ...conflict,
          publishedAt: conflict.status === 'PUBLISHED' ? new Date() : null,
        },
      });
      const before = await allRows(native);
      const error = await initializeScenarios(db, sql).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ScenarioInitializationError);
      expect((error as ScenarioInitializationError).keys).toEqual([`SCENARIO/${last.key}/1`]);
      expect(await allRows(native)).toEqual(before);
    });
  },
);

it('S5 단일 DO 자체가 마지막 충돌에서 앞 삽입까지 원자 거부한다', async () => {
  await withDatabase(async ({ db, native }) => {
    const last = readyScenarioRows().at(-1)!;
    await db.gameResource.create({
      data: {
        kind: 'SCENARIO',
        name: last.key,
        version: 1,
        status: 'DRAFT',
        content: {},
        contentHash: '0'.repeat(64),
        source: '다른 출처',
      },
    });
    const before = await allRows(native);
    await expect(native.query(sql)).rejects.toThrow(`시나리오 자원 충돌: SCENARIO/${last.key}/1`);
    expect(await allRows(native)).toEqual(before);
  });
});

it('S5 작은따옴표가 있는 source와 내용도 원문으로 되읽는다', async () => {
  await withDatabase(async ({ db }) => {
    const content = { ...JSON.parse(input['1010']!), $comment: "Source: original's 'quoted' content" };
    const source = "core2026's 'source'";
    const rows = scenarioRows.map((row) =>
      row.key === '1010' ? { ...row, contentHash: hashState(content), source } : row,
    );
    const quoted = convertScenariosToSql({ ...input, '1010': JSON.stringify(content) }, notice, materials, rows);
    expect(await initializeScenarios(db, quoted, rows)).toEqual({ inserted: 9, existing: 0 });
    const saved = await db.gameResource.findUniqueOrThrow({
      where: { kind_name_version: { kind: 'SCENARIO', name: '1010', version: 1 } },
    });
    expect(saved.source).toBe(source);
    expect(saved.content).toEqual(content);
    expect(saved.contentHash).toBe(hashState(content));
  });
});

it.each(ready)('S6 $key 두 DB 월드의 행 수와 재적재 해시는 파일 합성과 같다', async (row) => {
  await withDatabase(async ({ db }) => {
    await initializeScenarios(db, sql);
    const options = { scenario: row.key, map: 'che', seed: 't4-46-a' };
    const fromFile = await loadInitialWorld(options);
    for (let index = 0; index < 2; index++) {
      const initial = await loadInitialWorldFromDb(db, options);
      expect(hashState(initial)).toBe(hashState(fromFile));
      expect(hashState(initial)).toBe(row.initialHashes!['t4-46-a']);
      const { worldId } = await saveInitialWorld(db, initial, {
        name: `시나리오 ${row.key}`,
        turnTermMinutes: 60,
        endYear: null,
      });
      expect(await db.city.count({ where: { worldId } })).toBe(row.expected!.cities);
      expect(await db.nation.count({ where: { worldId } })).toBe(row.expected!.nations);
      expect(await db.general.count({ where: { worldId } })).toBe(row.expected!.generals);
      expect(hashState(await readWorldState(db, worldId))).toBe(hashState(initial));
    }
  });
});

it.each(ready)('S8 $key 전체 장수가 있는 DB 월드를 한 달 정산한다', async (row) => {
  await withDatabase(async ({ db }) => {
    await initializeScenarios(db, sql);
    const initial = await loadInitialWorldFromDb(db, { scenario: row.key, map: 'che', seed: 't4-46-a' });
    const { worldId } = await saveInitialWorld(db, initial, {
      name: `시나리오 ${row.key} 한 달`,
      turnTermMinutes: 60,
      endYear: null,
    });
    expect(await db.general.count({ where: { worldId } })).toBe(row.expected!.generals);
    await controlClock(db, worldId, 'start');
    const lease = await acquireLease(db, worldId);
    if (!lease) throw new Error('시나리오 월드의 실행권을 얻지 못했습니다.');
    try {
      const loop = new TurnLoop(db, lease);
      for (let tick = 1000; tick <= TICKS_PER_MONTH; tick += 1000) {
        await renewLease(db, lease);
        await loop.advanceTo(tick);
      }
    } finally {
      await releaseLease(db, lease);
    }
    const saved = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    expect(saved.clockTick).toBe(TICKS_PER_MONTH);
    expect(
      await db.yearbookSnapshot.findUnique({ where: { worldId_tick: { worldId, tick: TICKS_PER_MONTH } } }),
    ).not.toBeNull();
  });
});
