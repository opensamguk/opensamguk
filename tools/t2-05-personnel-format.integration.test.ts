import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import {
  capsResourceHashInput,
  checkReplayOrigin,
  parseCapsOrigin,
  selectSupportedCapabilities,
  selectWorldCapabilities,
} from '../packages/rules/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import legacy from '../apps/engine/test/fixtures/replay-v1-b8f5074.json';
import { testDatabaseUrl } from './test-database';

type PgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
type Catalog = { datname: string; oid: string }[];
type Snapshot = {
  id: string;
  data: Record<string, unknown>;
  origin: unknown;
  stateHash: unknown;
  resourceHash: unknown;
};
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(dbRequire.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => PgClient;
};
const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
const marker = '20261024000000_world_personnel_format';
const required20 = [
  '20261020000000_initial_world',
  '20261020010000_world_clock',
  '20261020020000_accounts',
  '20261020030000_engine_turns',
  '20261020040000_monthly_replay',
  '20261021030000_commands_war',
  '20261021040000_rankings',
  '20261021080000_engine_heartbeat',
  '20261023000000_world_outcome',
  '20261023010000_public_map_snapshot',
  '20261023020000_nation_display_archive',
  '20261023030000_messaging_realtime',
  '20261023040000_world_presets',
  '20261023050000_default_policy',
  '20261023060000_operation_plans',
  '20261023071000_nation_offices',
  '20261023072000_world_ext_slices',
  '20261023073000_treaties',
  '20261023074000_assignment_storage',
  '20261024000000_replay_features',
];

async function catalog(admin: PgClient): Promise<Catalog> {
  return (await admin.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows.map((row) => {
    if (typeof row.datname !== 'string' || typeof row.oid !== 'string') throw new Error('DB 목록을 확인하세요.');
    return { datname: row.datname, oid: row.oid };
  });
}

async function snapshots(client: PgClient, ids: string[]): Promise<Snapshot[]> {
  const rows = await client.query(
    `SELECT id,to_jsonb(t) AS data,"replayOrigin" AS origin,"initialStateHash" AS "stateHash",
       "replayOrigin"->>'resourceHash' AS "resourceHash"
     FROM "World" t WHERE id=ANY($1::text[]) ORDER BY id`,
    [ids],
  );
  expect(rows.rows).toHaveLength(ids.length);
  return rows.rows.map((row) => {
    if (typeof row.id !== 'string' || row.data === null || typeof row.data !== 'object' || Array.isArray(row.data))
      throw new Error('월드 저장 값을 확인하세요.');
    return {
      id: row.id,
      data: row.data as Record<string, unknown>,
      origin: row.origin,
      stateHash: row.stateHash,
      resourceHash: row.resourceHash,
    };
  });
}

async function markerColumn(client: PgClient) {
  return (
    await client.query(
      `SELECT data_type,udt_name,is_nullable,column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='World' AND column_name='personnelFormat'`,
    )
  ).rows;
}

async function insertOldWorld(client: PgClient, id: string, origin: unknown, treaty: boolean) {
  const initial = legacy.origin.initial;
  await client.query(
    `INSERT INTO "World" (id,name,"scenarioKey","mapKey","unitSetKey",seed,"startYear","turnTermMinutes",
       status,"clockTick","actionSequence","initialStateHash","statRules","unitSet","replayOrigin","treatyFormat","policyFromSequence")
     VALUES ($1,$1,$2,$3,$4,$5,$6,30,'PAUSED',1234,7,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12)`,
    [
      id,
      initial.scenarioKey,
      initial.mapKey,
      initial.unitSetKey,
      initial.seed,
      initial.startYear,
      legacy.origin.initialStateHash,
      JSON.stringify(initial.statRules),
      JSON.stringify(initial.unitSet),
      JSON.stringify(origin),
      treaty ? 1 : null,
      treaty ? 0 : null,
    ],
  );
}

it('PG-B8-1 인사 표지 migration은 구 SQL fixture를 보존하고 현재 factory의 두 OFF 월드를 만든다', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('시험 접속값이 필요합니다.');
  let source: URL;
  try {
    source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  } catch {
    throw new Error('시험 접속값을 확인하세요.');
  }
  if (!['127.0.0.1', 'localhost'].includes(source.hostname) || !['5432', '5433'].includes(source.port || '5432'))
    throw new Error('loopback 5432 또는 5433 시험 서버가 필요합니다.');
  for (const key of source.searchParams.keys())
    if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
      throw new Error('접속 대상 질의 인자는 쓸 수 없습니다.');
  source.port ||= '5432';
  const name = `t205_personnel_format_${randomUUID().replaceAll('-', '')}_test`;
  if (!/^t205_personnel_format_[a-f0-9]{32}_test$/.test(name)) throw new Error('자체 DB 이름을 확인하세요.');
  const adminUrl = new URL(source),
    target = new URL(source);
  adminUrl.pathname = '/postgres';
  target.pathname = `/${name}`;
  const admin = new Client({ connectionString: adminUrl.href });
  const client = new Client({ connectionString: target.href });
  let db: ReturnType<typeof createDb> | undefined;
  let adminConnected = false,
    created = false,
    completed = false,
    dropped = false;
  let createdOid: string | null = null,
    connectionsBeforeDrop: number | null = null;
  let before: Catalog = [],
    after: Catalog | null = null;
  let bodyFailed = false,
    cleanupFailed = false;
  let bodyError: unknown, cleanupError: unknown;
  let adminClosed = false;
  const applied: string[] = [];
  try {
    await admin.connect();
    adminConnected = true;
    before = await catalog(admin);
    if (before.some((row) => row.datname === name)) throw new Error('자체 시험 DB가 이미 있습니다.');
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    createdOid = (await catalog(admin)).find((row) => row.datname === name)?.oid ?? null;
    console.info('T2-05 인사 표지 DB 생성', JSON.stringify({ name, createdOid }));
    expect(createdOid).not.toBeNull();
    await client.connect();
    const directories = (await readdir(migrations)).filter((directory) => /^\d{14}_/.test(directory)).sort();
    expect(directories.slice(0, required20.length)).toEqual(required20);
    expect(directories[required20.length]).toBe(marker);
    async function apply(directory: string) {
      await client.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'));
      applied.push(directory);
    }
    for (const directory of directories.slice(0, required20.length)) await apply(directory);
    expect(await markerColumn(client)).toEqual([]);

    // 구 schema의 직접 SQL metadata fixture다. 옛 선택자나 게임 경로를 실행하지 않는다.
    const treatyOrigin = parseCapsOrigin({
      ...legacy.origin,
      version: 6,
      resourceHash: '',
      capabilities: { version: 1, treaty: { version: 1 } },
    });
    treatyOrigin.resourceHash = hashState(capsResourceHashInput(treatyOrigin));
    const expectedOrigins = new Map<string, unknown>([
      ['legacy-origin1', structuredClone(legacy.origin)],
      ['treaty-origin6', structuredClone(treatyOrigin)],
    ]);
    const policy = { version: 1 as const, fromSequence: 0, turnTermMinutes: 30 };
    const expectedSelections = new Map<string, unknown>([
      ['legacy-origin1', { kind: 'legacy', policy: null }],
      [
        'treaty-origin6',
        { kind: 'caps', origin: structuredClone(treatyOrigin), selection: { treaty: { version: 1 }, policy } },
      ],
    ]);
    expect(selectSupportedCapabilities(treatyOrigin, { endYear: null, outcomeFromSequence: 0, policy })).toEqual({
      treaty: { version: 1 },
      policy,
    });
    await insertOldWorld(client, 'legacy-origin1', legacy.origin, false);
    await insertOldWorld(client, 'treaty-origin6', treatyOrigin, true);
    const ids = [...expectedOrigins.keys()];
    const old = await snapshots(client, ids);
    for (const row of old) {
      expect(row.origin).toEqual(expectedOrigins.get(row.id));
      expect(row.stateHash).toBe(legacy.origin.initialStateHash);
      expect(row.resourceHash).toBe(
        row.id === 'legacy-origin1' ? legacy.origin.resourceHash : treatyOrigin.resourceHash,
      );
      expect(row.data).not.toHaveProperty('personnelFormat');
    }

    await apply(marker);
    expect(await markerColumn(client)).toEqual([
      { data_type: 'integer', udt_name: 'int4', is_nullable: 'YES', column_default: null },
    ]);
    const atMarker = await snapshots(client, ids);
    for (let index = 0; index < old.length; index++) {
      const { personnelFormat, ...oldColumns } = atMarker[index]!.data;
      expect(personnelFormat).toBeNull();
      expect(oldColumns).toEqual(old[index]!.data);
      expect(atMarker[index]!.origin).toEqual(old[index]!.origin);
      expect(atMarker[index]!.stateHash).toEqual(old[index]!.stateHash);
      expect(atMarker[index]!.resourceHash).toEqual(old[index]!.resourceHash);
    }
    for (const directory of directories.slice(required20.length + 1)) await apply(directory);
    const afterTails = await snapshots(client, ids);
    for (let index = 0; index < old.length; index++) {
      expect(afterTails[index]!.data.personnelFormat).toBeNull();
      for (const key of Object.keys(old[index]!.data))
        expect(afterTails[index]!.data[key]).toEqual(old[index]!.data[key]);
    }
    expect(
      (
        await client.query(
          'SELECT id,"personnelFormat" IS NULL AS "isNull" FROM "World" WHERE id=ANY($1::text[]) ORDER BY id',
          [ids],
        )
      ).rows,
    ).toEqual(ids.map((id) => ({ id, isNull: true })));

    // 현재 client는 표지와 모든 꼬리 migration을 적용한 뒤 처음 만든다.
    db = createDb(target.href);
    for (const id of ids) {
      const row = await db.world.findUniqueOrThrow({ where: { id } });
      expect(row.personnelFormat).toBeNull();
      expect(row.replayFormat).toBe(1);
      expect(row.ruleFeatures).toEqual([]);
      expect(selectWorldCapabilities(row)).toEqual(expectedSelections.get(id));
    }
    const initial = commandInitial();
    expect(initial.generals.every((general) => general.userId === null)).toBe(true);
    const initialHash = hashState(initial),
      factoryIds: string[] = [];
    for (const treaty of [false, true]) {
      const result = await saveInitialWorld(db, initial, {
        name: treaty ? '조약 단독 OFF' : '일반 OFF',
        turnTermMinutes: 30,
        endYear: null,
        ...(treaty ? { treatyFormat: 1 as const } : {}),
      });
      factoryIds.push(result.worldId);
      const row = await db.world.findUniqueOrThrow({ where: { id: result.worldId } });
      const expectedOrigin = treaty
        ? parseCapsOrigin({
            version: 6,
            initial,
            initialStateHash: initialHash,
            resourceHash: '',
            capabilities: { version: 1, treaty: { version: 1 } },
          })
        : { version: 3, initial, initialStateHash: initialHash, resourceHash: '' };
      expectedOrigin.resourceHash = treaty
        ? hashState(capsResourceHashInput(expectedOrigin as Parameters<typeof capsResourceHashInput>[0]))
        : hashState({
            scenarioKey: initial.scenarioKey,
            mapKey: initial.mapKey,
            unitSetKey: initial.unitSetKey,
            statRules: initial.statRules,
            unitSet: initial.unitSet,
          });
      expect(result.stateHash).toBe(initialHash);
      expect(row.initialStateHash).toBe(initialHash);
      expect(row.personnelFormat).toBeNull();
      expect(row.treatyFormat).toBe(treaty ? 1 : null);
      expect(row.replayFormat).toBe(treaty ? 1 : 3);
      expect(row.ruleFeatures).toEqual([]);
      expect(row.policyFromSequence).toBe(treaty ? 0 : null);
      expect(row.replayOrigin).toEqual(expectedOrigin);
      if (treaty)
        expect(selectWorldCapabilities(row)).toEqual({
          kind: 'caps',
          origin: expectedOrigin,
          selection: { treaty: { version: 1 }, policy },
        });
      else expect(() => checkReplayOrigin(row.replayOrigin)).not.toThrow();
    }
    expect(
      (
        await client.query(
          'SELECT id,"personnelFormat" IS NULL AS "isNull" FROM "World" WHERE id=ANY($1::text[]) ORDER BY id',
          [factoryIds],
        )
      ).rows,
    ).toEqual([...factoryIds].sort().map((id) => ({ id, isNull: true })));
    for (const table of ['AssignmentOffer', 'NationOffice', 'NationOfficeTurn'])
      expect(
        (
          await client.query(`SELECT count(*)::int AS count FROM "${table}" WHERE "worldId"=ANY($1::text[])`, [
            factoryIds,
          ])
        ).rows,
      ).toEqual([{ count: 0 }]);
    expect(applied).toEqual(directories);
    console.info(
      'T2-05 인사 표지 migration',
      JSON.stringify({
        name,
        applied,
        requiredPrefix: required20.length,
        marker,
        tailCount: directories.length - required20.length - 1,
        oldSqlFixtureRows: 2,
        currentFactoryRows: factoryIds.length,
      }),
    );
    completed = true;
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  } finally {
    const closed = await Promise.allSettled([client.end(), ...(db ? [db.$disconnect()] : [])]);
    const ownClosed = closed.every((result) => result.status === 'fulfilled');
    try {
      expect(ownClosed, '자체 연결 종료').toBe(true);
      if (adminConnected) {
        if (created) {
          expect(createdOid).not.toBeNull();
          expect((await catalog(admin)).find((row) => row.datname === name)).toEqual({
            datname: name,
            oid: createdOid,
          });
          const count = (
            await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name])
          ).rows;
          if (typeof count[0]?.count === 'number') connectionsBeforeDrop = count[0].count;
          expect(count).toEqual([{ count: 0 }]);
          await admin.query(`DROP DATABASE "${name}"`);
          dropped = true;
        }
        after = await catalog(admin);
        expect(after).toEqual(before);
      }
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    } finally {
      try {
        await admin.end();
        adminClosed = true;
      } catch (error) {
        cleanupFailed = true;
        cleanupError ??= error;
      }
      console.info(
        'T2-05 인사 표지 DB 정리',
        JSON.stringify({
          name,
          createdOid,
          created,
          completed,
          ownClosed,
          adminClosed,
          connectionsBeforeDrop,
          dropped,
          leftDatabase: created && !dropped ? name : null,
          before,
          after,
          catalogEqual: after !== null && JSON.stringify(after) === JSON.stringify(before),
          migrationsApplied: applied.length,
          bodyFailed,
          cleanupFailed,
        }),
      );
    }
  }
  if (bodyFailed) throw bodyError;
  if (cleanupFailed) throw cleanupError;
});
