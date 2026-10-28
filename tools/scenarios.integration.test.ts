import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

function ownedDatabase(initialize = true) {
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
  const cleanupErrors: unknown[] = [];
  return {
    async setup(): Promise<Fixture> {
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
      for (const name of names)
        await native.query(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
      db = createDb(url.href);
      if (initialize)
        await initializeResources(db, await readFile(new URL('packages/db/sql/resources-init.sql', root), 'utf8'));
      return { db, native, url };
    },
    async close(): Promise<void> {
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
          expect(
            (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [name])).rows,
          ).toEqual([{ oid }]);
          // Closing the client socket can precede PostgreSQL removing its backend.
          let activity = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1', [
            name,
          ]);
          for (let attempt = 0; activity.rows[0]?.count !== 0 && attempt < 20; attempt++) {
            await delay(50);
            activity = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1', [
              name,
            ]);
          }
          expect(activity.rows).toEqual([{ count: 0 }]);
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
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '자기 DB 정리가 실패했습니다.');
    },
  };
}

async function withDatabase(action: (value: Fixture) => Promise<void>, initialize = true): Promise<void> {
  const owned = ownedDatabase(initialize);
  let failure: unknown;
  try {
    await action(await owned.setup());
  } catch (error) {
    failure = error;
  }
  try {
    await owned.close();
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], '시험과 자기 DB 정리가 실패했습니다.', { cause: error });
    throw error;
  }
  if (failure) throw failure;
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

describe.each(ready)('S8 $key 전체 장수가 있는 DB 월드', (row) => {
  const owned = ownedDatabase();
  let fixture: Fixture;
  let worldId: string;
  // 준비·월내 각 구간·정리는 기존 30초 제한을 지킨다. 월 전체의 성능 제한은 아니다.
  let preparation: Promise<void> | undefined;
  const executions = new Set<Promise<void>>();
  const checkpoints = Array.from({ length: TICKS_PER_MONTH / 1000 }, (_, index) => (index + 1) * 1000);
  const batches = [checkpoints.slice(0, 4), checkpoints.slice(4, 8), checkpoints.slice(8)];
  const executedTicks: number[] = [];
  const phaseMs: number[] = [];
  let completedTick = 0,
    active = false,
    failed = false,
    startedAt: number | undefined;
  beforeAll(() => {
    preparation = (async () => {
      fixture = await owned.setup();
      const { db } = fixture;
      await initializeScenarios(db, sql);
      const initial = await loadInitialWorldFromDb(db, { scenario: row.key, map: 'che', seed: 't4-46-a' });
      ({ worldId } = await saveInitialWorld(db, initial, {
        name: `시나리오 ${row.key} 한 달`,
        turnTermMinutes: 60,
        endYear: null,
      }));
      expect(await db.general.count({ where: { worldId } })).toBe(row.expected!.generals);
    })();
    return preparation;
  });
  afterAll(async () => {
    // Vitest의 hook timeout은 원래 Promise를 취소하지 않는다. 생성이 끝난 뒤 자기 DB를 정리한다.
    // 준비 오류는 beforeAll이 이미 실패로 기록하며 정리 오류는 이 hook에서 따로 보고한다.
    await preparation?.catch(() => undefined);
    while (executions.size) await Promise.allSettled([...executions]);
    console.info(
      JSON.stringify({
        fixture: 'scenario-S8-month',
        scenario: row.key,
        completedTick,
        executedTicks,
        phaseMs: phaseMs.map(Math.round),
        totalPhaseMs: Math.round(phaseMs.reduce((sum, value) => sum + value, 0)),
        elapsedMonthMs: startedAt === undefined ? null : Math.round(performance.now() - startedAt),
        failed,
      }),
    );
    await owned.close();
  });
  for (const [index, ticks] of batches.entries()) {
    const from = index === 0 ? 0 : batches[index - 1]!.at(-1)!,
      target = ticks.at(-1)!;
    it(`월내 ${index + 1}구간 ${from}~${target}tick과 정산 경계를 저장한다`, ({ onTestFailed }) => {
      // Vitest timeout 뒤 원래 Promise가 성공해도 뒤 구간을 다시 열지 않는다.
      onTestFailed(() => {
        failed = true;
      });
      if (failed || active || completedTick !== from)
        throw new Error('시나리오 앞 구간이 실패했거나 아직 끝나지 않았습니다.');
      active = true;
      startedAt ??= performance.now();
      const execution = (async () => {
        const began = performance.now(),
          { db } = fixture,
          errors: unknown[] = [];
        let lease: Awaited<ReturnType<typeof acquireLease>> = null;
        try {
          expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick).toBe(from);
          if (index === 0) await controlClock(db, worldId, 'start');
          lease = await acquireLease(db, worldId);
          if (!lease) throw new Error('시나리오 월드의 실행권을 얻지 못했습니다.');
          const loop = new TurnLoop(db, lease);
          for (const tick of ticks) {
            await renewLease(db, lease);
            await loop.advanceTo(tick);
            executedTicks.push(tick);
          }
          const saved = await db.world.findUniqueOrThrow({ where: { id: worldId } });
          expect(saved.clockTick).toBe(target);
          expect(await db.general.count({ where: { worldId } })).toBe(row.expected!.generals);
          if (target === TICKS_PER_MONTH) {
            expect(saved.monthlyTick).toBe(TICKS_PER_MONTH);
            expect(executedTicks).toEqual(checkpoints);
            expect(
              await db.yearbookSnapshot.findUnique({
                where: { worldId_tick: { worldId, tick: TICKS_PER_MONTH } },
              }),
            ).not.toBeNull();
          } else {
            expect(saved.monthlyTick).toBe(0);
            expect(
              await db.yearbookSnapshot.findUnique({
                where: { worldId_tick: { worldId, tick: TICKS_PER_MONTH } },
              }),
            ).toBeNull();
          }
        } catch (error) {
          errors.push(error);
        } finally {
          if (lease)
            try {
              await releaseLease(db, lease);
            } catch (error) {
              errors.push(error);
            }
          phaseMs[index] = performance.now() - began;
        }
        if (errors.length) {
          failed = true;
          throw new AggregateError(errors, '시나리오 구간 실행과 실행권 해제 실패');
        }
        completedTick = target;
      })();
      executions.add(execution);
      void execution
        .finally(() => {
          active = false;
          executions.delete(execution);
        })
        .catch(() => undefined);
      return execution;
    });
  }
});
