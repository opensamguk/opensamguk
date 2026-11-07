import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type PrismaClient } from '../packages/db/src/index';
import { buildInitialWorld, scenarioSchema, TICKS_PER_MONTH } from '../packages/rules/src/index';
import { validateWorldResources } from '../packages/rules/src/world/validate';
import { hashState } from '../packages/shared/src/node/hashState';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld, readWorldState, type InitialWorldOptions } from '../apps/engine/src/world/persistence';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import fixture from './fixtures/t4-46-scenarios.json';
import { initializeResources } from './init-resources';
import { initializeScenarios, ScenarioInitializationError } from './init-scenarios';
import { pnpmCli } from './node-cli';
import {
  convertScenariosToSql,
  cheUnitSetPublication,
  readyScenarioRows,
  scenarioRows,
  scenarioMaterialsForRow,
  readScenarioMaterials,
  type ScenarioRow,
  type ScenarioMaterials,
  SCENARIO_BODY_TAG,
  SCENARIO_CONTENT_TAG,
  STAT_RULES_CONTENT_TAG,
  UNIT_SET_CONTENT_TAG,
} from './resources-sql/generate-scenarios';
import { BODY_TAG, CONTENT_TAG } from './resources-sql/convert';
import { testDatabaseUrl } from './test-database';

const root = new URL('../', import.meta.url);
const ready = fixture.scenarios.filter((row) => row.support === 'ready');
function worldCreationFeatures(row: { bundle: string; unitSet?: string }) {
  if (row.unitSet === 'che') return ['battle-affinity-v2'];
  return row.bundle === 'B' ? ['nation-lifecycle-v1', 'personnel'] : undefined;
}
const input: Record<string, string> = Object.fromEntries(
  await Promise.all(
    readyScenarioRows().map(async ({ key }) => [
      key,
      await readFile(new URL(`resources/scenario/${key}.json`, root), 'utf8'),
    ]),
  ),
);
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
    expect(first.stdout).toContain('시나리오 자원 저장: 삽입 14, 기존 0');
    const once = await allRows(native);
    const second = await cli(url);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain('시나리오 자원 저장: 삽입 0, 기존 14');
    expect(await allRows(native)).toEqual(once);
    expect(once).toHaveLength(before.length + ready.length + 1);
    expect(once.map(({ row }) => row)).toContainEqual(
      expect.objectContaining({
        kind: 'UNIT_SET',
        name: 'che',
        version: 1,
        status: 'PUBLISHED',
        contentHash: cheUnitSetPublication.contentHash,
      }),
    );
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
  'S5 마지막 시나리오의 %s 충돌은 앞의 삽입도 롤백한다',
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

it('S5 che 병종판 충돌은 1021과 다른 시나리오 등록도 롤백한다', async () => {
  await withDatabase(async ({ db, native }) => {
    await db.gameResource.create({
      data: {
        kind: 'UNIT_SET',
        name: 'che',
        version: 1,
        status: 'DRAFT',
        content: {},
        contentHash: '0'.repeat(64),
        source: '다른 출처',
      },
    });
    const before = await allRows(native);
    const error = await initializeScenarios(db, sql).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ScenarioInitializationError);
    expect((error as ScenarioInitializationError).keys).toEqual(['UNIT_SET/che/1']);
    expect(await allRows(native)).toEqual(before);
  });
});

it('S5 능력치 판을 시나리오와 함께 게시하고 누락과 충돌 때 되돌린다', async () => {
  await withDatabase(async ({ db, native }) => {
    const publication = fixture.statRules[0]!;
    const content = { ...JSON.parse(input['1010']!), requiredStatRules: publication.content.stat };
    const row = readyScenarioRows().find(({ key }) => key === '1010')!;
    const rows = [{ ...row, statRules: publication.name, contentHash: hashState(content) }];
    const generated = convertScenariosToSql(
      { '1010': JSON.stringify(content) },
      notice,
      await readScenarioMaterials(db),
      rows,
    );
    const withoutStatRules =
      generated.slice(0, generated.indexOf(`  resource_content := ${STAT_RULES_CONTENT_TAG}`)) +
      `END;\n${SCENARIO_BODY_TAG};\n`;
    const key = `STAT_RULES/${publication.name}/1`;
    const where = { kind_name_version: { kind: 'STAT_RULES' as const, name: publication.name, version: 1 } };
    const before = await allRows(native);

    await expect(initializeScenarios(db, withoutStatRules, rows)).rejects.toMatchObject({ keys: [key] });
    expect(await allRows(native)).toEqual(before);

    await db.gameResource.create({
      data: {
        ...where.kind_name_version,
        status: 'DRAFT',
        content: {},
        contentHash: '0'.repeat(64),
        source: '다른 출처',
      },
    });
    const beforeConflict = await allRows(native);
    await expect(initializeScenarios(db, generated, rows)).rejects.toMatchObject({ keys: [key] });
    expect(await allRows(native)).toEqual(beforeConflict);
    await db.gameResource.delete({ where });

    expect(await initializeScenarios(db, generated, rows)).toEqual({ inserted: 1, existing: 0 });
    expect(await db.gameResource.findUniqueOrThrow({ where })).toMatchObject({
      status: 'PUBLISHED',
      source: publication.source,
      contentHash: publication.contentHash,
      content: publication.content,
    });
    expect(await initializeScenarios(db, withoutStatRules, rows)).toEqual({ inserted: 0, existing: 1 });
    const options = { scenario: '1010', map: 'che', seed: 't4-46-stat-rules' };
    await expect(loadInitialWorldFromDb(db, options)).rejects.toThrow(
      '시나리오와 장수 생성 능력치 판이 맞지 않습니다.',
    );
    const world = await loadInitialWorldFromDb(db, { ...options, statRules: publication.name });
    expect(world.statRules).toEqual(publication.content.stat);
  });
});

it('S5 작은따옴표가 있는 source와 내용도 원문으로 되읽는다', async () => {
  await withDatabase(async ({ db }) => {
    const content = { ...JSON.parse(input['1010']!), $comment: "Source: original's 'quoted' content" };
    const source = "core2026's 'source'";
    const rows = scenarioRows.map((row) =>
      row.key === '1010' ? { ...row, contentHash: hashState(content), source } : row,
    );
    const quoted = convertScenariosToSql(
      { ...input, '1010': JSON.stringify(content) },
      notice,
      await readScenarioMaterials(db),
      rows,
    );
    expect(await initializeScenarios(db, quoted, rows)).toEqual({ inserted: 14, existing: 0 });
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
    const options = {
      scenario: row.key,
      map: 'che',
      seed: 't4-46-a',
      ...(row.unitSet ? { unitSet: row.unitSet } : {}),
    };
    const ruleFeatures = worldCreationFeatures(row);
    if (row.unitSet === 'che')
      await expect(loadInitialWorldFromDb(db, { ...options, unitSet: 'basic' })).rejects.toThrow('che 병종 판');
    const fromFile = buildInitialWorld({
      ...scenarioMaterialsForRow(await readScenarioMaterials(db), row),
      scenario: JSON.parse(input[row.key]!),
      seed: options.seed,
    });
    for (let index = 0; index < 2; index++) {
      const initial = await loadInitialWorldFromDb(db, options);
      expect(hashState(initial)).toBe(hashState(fromFile));
      expect(hashState(initial)).toBe(row.initialHashes!['t4-46-a']);
      const { worldId } = await saveInitialWorld(db, initial, {
        name: `시나리오 ${row.key}`,
        turnTermMinutes: 60,
        endYear: null,
        ...(ruleFeatures ? { ruleFeatures } : {}),
      });
      expect(await db.city.count({ where: { worldId } })).toBe(row.expected!.cities);
      expect(await db.nation.count({ where: { worldId } })).toBe(row.expected!.nations);
      expect(await db.general.count({ where: { worldId } })).toBe(row.expected!.generals);
      expect(hashState(await readWorldState(db, worldId))).toBe(
        hashState(ruleFeatures ? { ...initial, ruleFeatures } : initial),
      );
    }
  });
});

it.each([
  { key: '1050', nationId: 8, members: 4, unplaced: 3, rulerCity: '업' },
  { key: '1080', nationId: 6, members: 3, unplaced: 2, rulerCity: '한중' },
])('B2 $key 명시적 CLI 생성·시작 방랑·구형 거부와 손상 적재를 검증한다', async (row) => {
  await withDatabase(async ({ db, url }) => {
    await initializeScenarios(db, sql);
    const initial = await loadInitialWorldFromDb(db, { scenario: row.key, map: 'che', seed: 't4-46-a' });
    const options = { name: `시작 방랑 ${row.key}`, turnTermMinutes: 60, endYear: 300 };
    const invalid: Array<Partial<InitialWorldOptions>> = [
      {},
      { replayFormat: 'legacy' },
      { replayFormat: 'policy' },
      { treatyFormat: 1 },
      { extFormat: 1 },
      { ruleFeatures: ['personnel'] },
      { replayFormat: 1, ruleFeatures: ['nation-lifecycle-v1', 'personnel'] },
    ];
    for (const disabled of invalid) {
      await expect(saveInitialWorld(db, initial, { ...options, ...disabled })).rejects.toThrow('시작 방랑');
      expect(await db.world.count()).toBe(0);
      expect(await db.nation.count()).toBe(0);
    }
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/engine/src/cli/createWorld.ts',
        '--scenario',
        row.key,
        '--map',
        'che',
        '--seed',
        't4-46-a',
        '--rule-features',
        'personnel,nation-lifecycle-v1',
        '--turn-term',
        '60',
        '--end-year',
        '300',
        '--name',
        options.name,
      ],
      { cwd: root, env: { ...process.env, DATABASE_URL: url.href }, encoding: 'utf8', timeout: 30000 },
    );
    const result = JSON.parse(output) as { worldId: string; stateHash: string };
    const { worldId } = result;
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    expect(world.ruleFeatures).toEqual(['nation-lifecycle-v1', 'personnel']);
    expect(world.nationLifecycleState).toEqual({ version: 1, nations: { [row.nationId]: { sinceTick: 0 } } });
    expect(result.stateHash).toBe(hashState({ ...initial, ruleFeatures: world.ruleFeatures }));
    expect(await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: row.nationId } } })).toMatchObject({
      capitalCityKey: null,
    });
    expect(await db.city.count({ where: { worldId, nationId: row.nationId } })).toBe(0);
    const source = scenarioSchema.parse(JSON.parse(input[row.key]!));
    const members = source.general.filter((general) => general[3] === row.nationId);
    expect(members).toHaveLength(row.members);
    expect(members.filter((general) => general[4] === null)).toHaveLength(row.unplaced);
    const rulerCity = initial.cities.find((city) => city.name === row.rulerCity)!.cityKey;
    expect(initial.generals.some((general) => general.nationId === row.nationId && general.cityKey !== rulerCity)).toBe(
      true,
    );
    for (const [index, general] of source.general.entries()) {
      expect(initial.generals[index]!.nationId).toBe(general[3] === 0 ? null : general[3]);
      if (general[4] !== null)
        expect(initial.generals[index]!.cityKey).toBe(initial.cities.find((city) => city.name === general[4])!.cityKey);
    }
    await db.world.update({ where: { id: worldId }, data: { nationLifecycleState: { version: 1, nations: {} } } });
    await expect(readWorldState(db, worldId)).rejects.toThrow('방랑 원장');
    await expect(db.$transaction((tx) => loadReplayState(tx, worldId))).rejects.toThrow('방랑 원장');
    await db.world.update({ where: { id: worldId }, data: { nationLifecycleState: world.nationLifecycleState! } });
    const city = initial.cities[0]!;
    await db.city.update({
      where: { worldId_cityKey: { worldId, cityKey: city.cityKey } },
      data: { nationId: row.nationId },
    });
    await expect(readWorldState(db, worldId)).rejects.toThrow('방랑 국가가 도시');
    await expect(db.$transaction((tx) => loadReplayState(tx, worldId))).rejects.toThrow('방랑 국가가 도시');
    await db.city.update({
      where: { worldId_cityKey: { worldId, cityKey: city.cityKey } },
      data: { nationId: city.nationId },
    });
    const reopened = createDb(url.href);
    try {
      expect(hashState(await readWorldState(reopened, worldId))).toBe(result.stateHash);
    } finally {
      await reopened.$disconnect();
    }
  });
});

it.each(['2060', '2070'])(
  'E2 %s 로비에서 장수를 만들고 건국한 뒤 임관한다',
  async (key) => {
    await withDatabase(async ({ db, url }) => {
      await initializeScenarios(db, sql);
      const output = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'apps/engine/src/cli/createWorld.ts',
          '--scenario',
          key,
          '--map',
          'che',
          '--unit-set',
          'che',
          '--seed',
          't4-46-e2',
          '--turn-term',
          '60',
          '--end-year',
          '230',
          '--name',
          `공백지 ${key}`,
        ],
        { cwd: root, env: { ...process.env, DATABASE_URL: url.href }, encoding: 'utf8', timeout: 30000 },
      );
      const { worldId } = JSON.parse(output) as { worldId: string };
      await controlClock(db, worldId, 'start');
      const app = await buildServer({ db, logging: false });
      const currentWorld = () => db.world.findUniqueOrThrow({ where: { id: worldId } });
      const advance = async (tick: number) => {
        const lease = await acquireLease(db, worldId);
        if (!lease) throw new Error('공백지 월드의 실행권을 얻지 못했습니다.');
        try {
          await new TurnLoop(db, lease).advanceTo(tick);
        } finally {
          await releaseLease(db, lease);
        }
      };
      async function createPlayer(name: string, command: { commandKey: string; args: Record<string, unknown> }) {
        const userId = randomUUID();
        const session = newSession(Date.now());
        await db.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'test-only' } });
        await db.session.create({ data: { id: session.id, userId, expiresAt: session.expiresAt } });
        const headers = { origin: 'http://127.0.0.1:5173', cookie: `sid=${session.token}` };
        const lobby = await app.inject({ method: 'GET', url: '/trpc/lobby.worlds', headers });
        expect(lobby.statusCode).toBe(200);
        expect(lobby.json().result.data).toEqual([
          expect.objectContaining({
            id: worldId,
            startYear: 180,
            status: 'RUNNING',
            myGeneral: null,
            createBlockedReason: null,
          }),
        ]);
        const post = (route: string, payload: Record<string, unknown>) =>
          app.inject({ method: 'POST', url: `/trpc/${route}`, headers, payload: { worldId, ...payload } });
        const where = { worldId, userId, kind: 'general.create' as const };
        const creating = post('general.create', { name, leadership: 55, strength: 55, intel: 55, portraitId: null });
        try {
          const deadline = performance.now() + 5000;
          while (!(await db.inputEvent.findFirst({ where: { ...where, status: 'PENDING' } }))) {
            if (performance.now() >= deadline) throw new Error(`장수 생성 접수 결과: ${(await creating).body}`);
            await delay(10);
          }
          await advance((await currentWorld()).clockTick);
          const created = await creating;
          expect(created.statusCode, created.body).toBe(200);
        } finally {
          await creating;
        }
        expect(await db.inputEvent.findFirstOrThrow({ where })).toMatchObject({ status: 'APPLIED' });
        const actor = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId } } });
        const order = await post('turns.set', {
          revision: actor.turnRevision,
          slots: Array.from({ length: 30 }, (_, index) => (index === 0 ? command : null)),
        });
        expect(order.statusCode, order.body).toBe(200);
        expect(order.json().result.data).toMatchObject({ ok: true });
        await advance(actor.nextTurnTick);
        return db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId } } });
      }
      try {
        expect(await db.nation.count({ where: { worldId } })).toBe(0);
        const founder = await createPlayer('공백지군주', {
          commandKey: 'found',
          args: { name: '새 나라', color: '#224466' },
        });
        expect(founder).toMatchObject({ nationId: 1, officerLevel: 12 });
        expect(await db.nation.count({ where: { worldId } })).toBe(1);
        expect((await currentWorld()).status).toBe('RUNNING');
        const recruit = await createPlayer('공백지장수', { commandKey: 'join', args: { nationId: 1 } });
        expect(recruit).toMatchObject({ nationId: 1, officerLevel: 1 });
        const tick = (await currentWorld()).clockTick;
        await advance((Math.floor(tick / TICKS_PER_MONTH) + 1) * TICKS_PER_MONTH);
        expect((await currentWorld()).status).toBe('RUNNING');
        await expectReplayMatchesReloadedState(db, url, worldId);
      } finally {
        await app.close();
      }
    });
  },
  90000,
);

async function expectReplayMatchesReloadedState(db: PrismaClient, url: URL, worldId: string) {
  const archive = await exportReplay(db, worldId);
  expect(archive.months.length).toBeGreaterThan(0);
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs'; import {replayArchive} from './apps/engine/src/replay.ts'; const a=JSON.parse(readFileSync(0,'utf8')); console.log(JSON.stringify(replayArchive(a,a.months.length)));",
    ],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '' },
      input: JSON.stringify(archive),
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  expect(JSON.parse(output)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  const reopened = createDb(url.href);
  try {
    expect(hashState(await loadReplayState(reopened, worldId))).toBe(archive.months.at(-1)!.stateHash);
  } finally {
    await reopened.$disconnect();
  }
  return archive.months.length;
}

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
      const initial = await loadInitialWorldFromDb(db, {
        scenario: row.key,
        map: 'che',
        seed: 't4-46-a',
        ...(row.unitSet ? { unitSet: row.unitSet } : {}),
      });
      const ruleFeatures = worldCreationFeatures(row);
      ({ worldId } = await saveInitialWorld(db, initial, {
        name: `시나리오 ${row.key} 한 달`,
        turnTermMinutes: 60,
        endYear: null,
        ...(ruleFeatures ? { ruleFeatures } : {}),
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
            if (row.bundle === 'B' || row.unitSet === 'che') {
              expect(await expectReplayMatchesReloadedState(db, fixture.url, worldId)).toBe(1);
            }
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

describe('T4-46 / AC-P2-24 A9·B2 출처와 합성', () => {
  interface ScenarioCase extends ScenarioRow {
    originalText: string;
    correction: {
      nationIndex: number;
      cityListIndex: number;
      cityName: string;
      keptIndex: number;
      removedIndex: number;
    } | null;
    expected: { cities: number; nations: number; generals: number; startYear: number };
    initialHashes: Record<string, string>;
    validationWarnings: Array<{ slot: string; code: string }>;
  }
  const cases = fixture.scenarios.filter((row) => row.support === 'ready') as unknown as ScenarioCase[];
  let materials: ScenarioMaterials;
  beforeAll(async () => {
    const db = createDb(testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }).href);
    try {
      materials = await readScenarioMaterials(db);
      sql = convert();
    } finally {
      await db.$disconnect();
    }
  });
  const convert = (texts = input, rows: readonly ScenarioRow[] = scenarioRows, sourceNotice = notice) =>
    convertScenariosToSql(texts, sourceNotice, materials, rows);
  let sql: string;
  const contents = () =>
    [...sql.matchAll(/resource_content := \$t4_46_content\$([\s\S]*?)\$t4_46_content\$::jsonb;/g)].map(
      (match) => JSON.parse(match[1]!) as { id: string },
    );

  it('S0 준비 14종을 생성하고 기존 1종과 미검증 68종을 보존한다', () => {
    const counts = scenarioRows.reduce<Record<string, number>>((sum, row) => {
      sum[row.support] = (sum[row.support] ?? 0) + 1;
      return sum;
    }, {});
    expect(counts).toEqual({ ready: 14, existing: 1, unverified: 68 });
    expect(scenarioRows.filter(({ support }) => support === 'existing').map(({ key }) => key)).toEqual(['1030']);
    expect(scenarioRows.filter(({ support }) => support === 'blocked')).toEqual([]);
    const bundles = {
      A: ['1010', '1020', '1040', '1060', '1070', '1090', '1100', '1110', '1120'],
      B: ['1050', '1080'],
      C: ['1021', '1031', '1041'],
      existing: ['1030'],
      D: [
        '0',
        '1',
        '2',
        '900',
        '901',
        '902',
        '903',
        '904',
        '905',
        '906',
        '908',
        '910',
        '911',
        '912',
        '913',
        '914',
        '915',
        '916',
      ],
    };
    for (const [bundle, keys] of Object.entries(bundles))
      expect(scenarioRows.filter((row) => row.bundle === bundle).map(({ key }) => key)).toEqual(keys);
    expect(scenarioRows.filter(({ bundle }) => bundle === 'E')).toHaveLength(50);
    expect(readyScenarioRows().map(({ key }) => key)).toEqual([
      '1010',
      '1020',
      '1021',
      '1040',
      '1050',
      '1060',
      '1070',
      '1080',
      '1090',
      '1100',
      '1110',
      '1120',
      '2060',
      '2070',
    ]);
    expect(contents().map(({ id }) => id)).toEqual(readyScenarioRows().map(({ key }) => key));
    for (const row of scenarioRows.filter((row) => row.support !== 'ready')) {
      expect(row.reason.trim()).not.toBe('');
      expect(row.resourceKey).toBeNull();
      expect(row.contentHash).toBeNull();
    }
    expect(convert({ ...input, '2010': 'invalid JSON' })).toBe(sql);
    expect(fixture.$comment).toContain('MIT (c) 2025 devsam');
  });

  it.each(cases)('S2 $key 실제 검증기와 합성의 행 수·시작 연도를 확인한다', (row) => {
    const scenario = JSON.parse(input[row.key]!);
    const selected = scenarioMaterialsForRow(materials, row);
    const report = validateWorldResources({ ...selected, scenario });
    expect(report.status).toBe('pass');
    const warnings = Object.entries(report).flatMap(([slot, value]) =>
      typeof value === 'object' ? value.issues.map(({ code }) => ({ slot, code })) : [],
    );
    expect(warnings).toEqual(row.validationWarnings);
    const initial = buildInitialWorld({ ...selected, scenario, seed: 't4-46-a' });
    expect({
      cities: initial.cities.length,
      nations: initial.nations.length,
      generals: initial.generals.length,
      startYear: initial.startYear,
    }).toEqual(row.expected);
  });

  it.each(
    cases.flatMap((row) => Object.entries(row.initialHashes).map(([seed, expected]) => ({ ...row, seed, expected }))),
  )('S3 $key $seed 두 합성이 독립 고정 해시와 같다', (row) => {
    const scenario = JSON.parse(input[row.key]!);
    const selected = scenarioMaterialsForRow(materials, row);
    expect(hashState(buildInitialWorld({ ...selected, scenario, seed: row.seed }))).toBe(row.expected);
    expect(hashState(buildInitialWorld({ ...selected, scenario, seed: row.seed }))).toBe(row.expected);
  });

  it('S4 생성 SQL 바이트·숫자 정렬·단일 DO와 출처를 보존한다', async () => {
    expect(
      (await readFile(new URL('packages/db/sql/resources-scenarios.sql', root), 'utf8')).replaceAll('\r\n', '\n'),
    ).toBe(sql);
    expect(convert()).toBe(sql);
    expect(
      convert(
        Object.fromEntries(
          Object.entries(input).map(([key, raw]) => [key, raw.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')]),
        ),
      ),
    ).toBe(sql);
    expect(sql).not.toContain('\r');
    expect(sql).toContain('Copyright (c) 2025 devsam');
    expect(sql).toContain('tools/fixtures/t4-46-scenarios.json');
    const body = sql.replace(/^--.*\n/gm, '').replace(/\$t4_46_content\$[\s\S]*?\$t4_46_content\$/g, '');
    expect(body.match(/DO \$t4_46_init\$/g)).toHaveLength(1);
    expect(body.match(/ON CONFLICT \("kind", "name", "version"\) DO NOTHING/g)).toHaveLength(ready.length + 1);
    expect(body.match(/IF NOT EXISTS/g)).toHaveLength(ready.length + 1);
    expect(body).not.toMatch(/DO UPDATE|\bCOMMIT\b|\bROLLBACK\b/);
    for (const row of cases) expect(sql).toContain(row.source!.replaceAll("'", "''"));
  });

  it.each(['1030', 'che', 'basic', 'default', 'rtk14-map'])('S4 내장 키 %s를 거부한다', (key) => {
    expect(() => convert({ ...input, [key]: '{}' })).toThrow('내장 자원');
  });

  it.each([SCENARIO_CONTENT_TAG, SCENARIO_BODY_TAG, UNIT_SET_CONTENT_TAG, CONTENT_TAG, BODY_TAG])(
    'S4 %s 태그 충돌은 키만 내고 거부한다',
    (tag) => {
      const raw = JSON.stringify({ ...JSON.parse(input['1010']!), secret: `숨긴 원문 ${tag}` });
      expect(() => convert({ ...input, '1010': raw })).toThrow('구분자 충돌: SCENARIO/1010/1');
      expect(() => convert({ ...input, '1010': raw })).not.toThrow('숨긴 원문');
    },
  );

  it.each(['{"x":"\\u0000"}', '{"x\\u0000":1}', '{"x":[{"a":"\\u0000"}]}'])('S4 중첩 NUL을 거부한다 (%#)', (raw) => {
    expect(() => convert({ ...input, '1010': raw })).toThrow('NUL 문자: SCENARIO/1010/1');
  });

  it.each([SCENARIO_CONTENT_TAG, SCENARIO_BODY_TAG, UNIT_SET_CONTENT_TAG, CONTENT_TAG, BODY_TAG])(
    'S4 source의 %s 태그 충돌은 키만 내고 거부한다',
    (tag) => {
      const rows = scenarioRows.map((row) =>
        row.key === '1010' ? { ...row, source: `숨긴 출처 ${tag}; SELECT '원문';` } : row,
      );
      expect(() => convert(input, rows)).toThrow('구분자 충돌: SCENARIO/1010/1');
      expect(() => convert(input, rows)).not.toThrow('숨긴 출처');
      expect(() => convert(input, rows)).not.toThrow(tag);
    },
  );

  it.each(['{"a":"\0"}', '{"숨긴 원문":'])('S4 잘못된 JSON 내용을 출력하지 않는다 (%#)', (raw) => {
    expect(() => convert({ ...input, '1010': raw })).toThrow('JSON 오류: SCENARIO/1010/1');
    expect(() => convert({ ...input, '1010': raw })).not.toThrow('숨긴 원문');
  });

  it('S4 source와 JSON의 작은따옴표를 보존한다', () => {
    const content = { ...JSON.parse(input['1010']!), $comment: "Source: 'quoted' source" };
    const source = "original's 'source'";
    const rows = scenarioRows.map((row) =>
      row.key === '1010' ? { ...row, source, contentHash: hashState(content) } : row,
    );
    const quoted = convert({ ...input, '1010': JSON.stringify(content) }, rows);
    expect(quoted).toContain("'original''s ''source'''");
    const raw = [
      ...quoted.matchAll(/resource_content := \$t4_46_content\$([\s\S]*?)\$t4_46_content\$::jsonb;/g),
    ][0]![1]!;
    expect(JSON.parse(raw)).toEqual(content);
  });

  it('S4 source·NOTICE NUL과 상수 해시 불일치를 거부한다', () => {
    expect(() =>
      convert(
        input,
        scenarioRows.map((row) => (row.key === '1010' ? { ...row, source: 'x\0' } : row)),
      ),
    ).toThrow('NUL 문자');
    expect(() => convert(input, scenarioRows, 'x\0')).toThrow('출처에 NUL');
    expect(() => convert({ ...input, '1010': JSON.stringify({ ...JSON.parse(input['1010']!), extra: 1 }) })).toThrow(
      '상수 해시 불일치',
    );
    expect(() => convert({ ...input, '1010': undefined! })).toThrow('원문이 없습니다');
  });
});
