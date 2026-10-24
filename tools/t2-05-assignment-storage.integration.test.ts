import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import type { WorldInit } from '../packages/rules/src/index';
import { testDatabaseUrl } from './test-database';

type PgResult = { rows: Record<string, unknown>[] };
type PgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<PgResult>;
  end(): Promise<void>;
};
type Catalog = { datname: string; oid: string }[];
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pgRequire = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
const { Client } = pgRequire('pg') as { Client: new (config: { connectionString: string }) => PgClient };
const migration = '20261023074000_assignment_storage';
const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
const expectedHistoryEnd = '20261023073000_treaties';
const snapshotTables = [
  'World',
  'Nation',
  'City',
  'General',
  'GeneralLog',
  'NationTurn',
  'NationOffice',
  'NationOfficeTurn',
  'InputEvent',
  'YearbookSnapshot',
  'WorldResult',
  'WorldExtSlice',
  'Treaty',
] as const;

function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error('시험 식별자를 확인하세요.');
  return `"${value}"`;
}

async function insert(client: PgClient, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  return client.query(
    `INSERT INTO ${identifier(table)} (${keys.map(identifier).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  );
}

async function catalog(admin: PgClient): Promise<Catalog> {
  const result = await admin.query('SELECT datname, oid::text AS oid FROM pg_database ORDER BY datname');
  return result.rows.map((row) => {
    if (typeof row.datname !== 'string' || typeof row.oid !== 'string') throw new Error('DB 목록을 확인하세요.');
    return { datname: row.datname, oid: row.oid };
  });
}

// TEST_DATABASE_URL의 서버에 새 UUID DB만 만든다. 기존 DB는 사용하거나 지우지 않는다.
async function withDatabase(
  mode: 'empty' | 'legacy',
  run: (client: PgClient, db: ReturnType<typeof createDb>) => Promise<void>,
) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('시험 접속값이 필요합니다.');
  const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  if (!['127.0.0.1', 'localhost'].includes(source.hostname) || !['5432', '5433'].includes(source.port || '5432'))
    throw new Error('loopback 5432 또는 5433 시험 서버가 필요합니다.');
  const name = `t205_assignment_${mode}_${randomUUID().replaceAll('-', '')}_test`;
  if (!new RegExp(`^t205_assignment_${mode}_[a-f0-9]{32}_test$`).test(name))
    throw new Error('자체 시험 DB 이름을 확인하세요.');
  const adminUrl = new URL(source),
    target = new URL(source);
  adminUrl.pathname = '/postgres';
  target.pathname = `/${name}`;
  const admin = new Client({ connectionString: adminUrl.href });
  const client = new Client({ connectionString: target.href });
  const db = createDb(target.href);
  let created = false;
  let createdOid: string | null = null;
  let before: Catalog = [];
  let completed = false;
  let connections: number | null = null;
  let dropped = false;
  await admin.connect();
  try {
    before = await catalog(admin);
    if (before.some((row) => row.datname === name)) throw new Error('자체 시험 DB가 이미 있습니다.');
    await admin.query(`CREATE DATABASE ${identifier(name)}`);
    created = true;
    createdOid = (await catalog(admin)).find((row) => row.datname === name)?.oid ?? null;
    expect(createdOid).not.toBeNull();
    console.info('T2-05 저장표 DB 생성', JSON.stringify({ mode, name, createdOid }));
    await client.connect();
    await run(client, db);
    completed = true;
  } finally {
    try {
      const disconnected = await Promise.allSettled([client.end(), db.$disconnect()]);
      expect(
        disconnected.every((item) => item.status === 'fulfilled'),
        '자체 연결 종료',
      ).toBe(true);
      if (created) {
        const current = (await catalog(admin)).find((row) => row.datname === name);
        expect(current).toEqual({ datname: name, oid: createdOid });
        const count = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name]);
        expect(count.rows).toEqual([{ count: 0 }]);
        connections = 0;
        await admin.query(`DROP DATABASE ${identifier(name)}`);
        dropped = true;
      }
      const after = await catalog(admin);
      for (const row of before) expect(after).toContainEqual(row);
      expect(after.some((row) => row.datname === name)).toBe(false);
      console.info(
        'T2-05 저장표 DB 정리',
        JSON.stringify(
          {
            name,
            created,
            createdOid,
            completed,
            connectionsBeforeDrop: connections,
            dropped,
            before,
            after,
            existingDatabaseNamesAndOidsPreserved: true,
            existingGameDatabaseConnectionsOpened: 0,
            adminDatabase: 'postgres',
            forcedConnectionTermination: 0,
          },
          null,
          2,
        ),
      );
    } finally {
      await admin.end();
    }
  }
}

async function seed(client: PgClient) {
  const archive = JSON.parse(
    await readFile(new URL('../apps/engine/test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
  ) as {
    origin: { initial: WorldInit; initialStateHash: string };
  };
  const initial = archive.origin.initial;
  for (const worldId of ['one', 'two']) {
    await insert(client, 'World', {
      id: worldId,
      name: worldId,
      scenarioKey: initial.scenarioKey,
      mapKey: initial.mapKey,
      unitSetKey: initial.unitSetKey,
      seed: initial.seed,
      startYear: initial.startYear,
      turnTermMinutes: 30,
      initialStateHash: archive.origin.initialStateHash,
      statRules: initial.statRules,
      unitSet: initial.unitSet,
      replayOrigin: archive.origin,
    });
    await insert(client, 'Nation', { ...initial.nations[0]!, id: 1, worldId, capitalCityKey: null });
    const city = { ...initial.cities[0]!, worldId, nationId: 1, connections: [] };
    await insert(client, 'City', city);
    for (const generalId of [1, 2]) {
      await insert(client, 'General', {
        ...initial.generals[0]!,
        worldId,
        id: generalId,
        userId: null,
        nationId: 1,
        cityKey: city.cityKey,
      });
    }
    await insert(client, 'NationTurn', { worldId, nationId: 1, slot: 29, args: { legacy: true } });
    await insert(client, 'NationOffice', { worldId, nationId: 1, officerLevel: 5, turnRevision: 7, tenure: 3 });
    await insert(client, 'NationOfficeTurn', {
      worldId,
      nationId: 1,
      officerLevel: 5,
      slot: 11,
      args: { preserved: [1, null] },
    });
    for (const tick of [100, 200])
      await insert(client, 'GeneralLog', {
        worldId,
        generalId: 1,
        tick,
        commandKey: 'rest',
        kind: 'success',
        text: '기존 턴 기록',
      });
  }
}

async function snapshot(client: PgClient) {
  const result: Record<string, unknown> = {};
  for (const table of snapshotTables) {
    // 새 두 기본값 외에는 기존 행의 id·시각·내용을 그대로 비교한다.
    const expression = table === 'GeneralLog' ? "to_jsonb(t) - 'sequence' - 'ordinal'" : 'to_jsonb(t)';
    result[table] = (
      await client.query(
        `SELECT (${expression})::text AS row FROM ${identifier(table)} t ORDER BY (${expression})::text`,
      )
    ).rows;
  }
  return result;
}

async function verifyIndexes(client: PgClient) {
  const indexes = (
    await client.query(`SELECT tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename IN ('AssignmentOffer','GeneralLog') ORDER BY indexname`)
  ).rows;
  const index = (name: string) => {
    const row = indexes.find((value) => value.indexname === name);
    expect(row).toBeDefined();
    return String(row!.indexdef);
  };
  expect(index('AssignmentOffer_worldId_targetGeneralId_pending_key')).toMatch(
    /UNIQUE.*\("worldId", "targetGeneralId"\).*WHERE.*PENDING/,
  );
  expect(index('GeneralLog_worldId_generalId_tick_turn_key')).toMatch(
    /UNIQUE.*\("worldId", "generalId", tick\).*WHERE.*sequence IS NULL/,
  );
  expect(index('GeneralLog_worldId_generalId_sequence_ordinal_key')).toMatch(
    /UNIQUE.*\("worldId", "generalId", sequence, ordinal\).*WHERE.*sequence IS NOT NULL/,
  );
  expect(indexes.some((row) => row.indexname === 'GeneralLog_worldId_generalId_tick_key')).toBe(false);
  expect(indexes.filter((row) => row.tablename === 'GeneralLog')).toHaveLength(3); // pkey와 부분 유일 색인 둘
}

async function verifyOffers(client: PgClient, db: ReturnType<typeof createDb>) {
  const pending = {
    worldId: 'one',
    id: '300-1-2',
    nationId: 1,
    issuerGeneralId: 1,
    targetGeneralId: 2,
    cityKey: 1,
    status: 'PENDING' as const,
    createdTick: 300,
    expiresTick: 20300,
  };
  await db.assignmentOffer.create({ data: pending });
  await db.assignmentOffer.create({ data: { ...pending, worldId: 'two' } });
  expect(
    (await db.assignmentOffer.findUniqueOrThrow({ where: { worldId_id: { worldId: 'two', id: pending.id } } })).worldId,
  ).toBe('two');
  await expect(insert(client, 'AssignmentOffer', pending)).rejects.toMatchObject({
    code: '23505',
    constraint: 'AssignmentOffer_pkey',
  });
  await expect(
    insert(client, 'AssignmentOffer', { ...pending, id: '301-1-2', createdTick: 301 }),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'AssignmentOffer_worldId_targetGeneralId_pending_key',
  });
  await expect(insert(client, 'AssignmentOffer', { ...pending, worldId: 'missing' })).rejects.toMatchObject({
    code: '23503',
    constraint: 'AssignmentOffer_worldId_fkey',
  });
  const where = { worldId: 'one', id: pending.id, status: 'PENDING' as const };
  expect(
    (
      await db.assignmentOffer.updateMany({
        where,
        data: { status: 'ACCEPTED', resolvedBy: 'RESPONSE', resolvedTick: 301 },
      })
    ).count,
  ).toBe(1);
  const closed = await db.assignmentOffer.findUniqueOrThrow({
    where: { worldId_id: { worldId: 'one', id: pending.id } },
  });
  expect((await db.assignmentOffer.updateMany({ where, data: { status: 'REJECTED', resolvedTick: 302 } })).count).toBe(
    0,
  );
  expect(
    await db.assignmentOffer.findUniqueOrThrow({ where: { worldId_id: { worldId: 'one', id: pending.id } } }),
  ).toEqual(closed);
  expect(
    (await db.assignmentOffer.findUniqueOrThrow({ where: { worldId_id: { worldId: 'two', id: pending.id } } })).status,
  ).toBe('PENDING');
  const terminal = [
    { status: 'ACCEPTED', resolvedBy: 'EXPIRY', cancelReason: null },
    { status: 'REJECTED', resolvedBy: 'RESPONSE', cancelReason: null },
    { status: 'SUPERSEDED', resolvedBy: null, cancelReason: null },
    ...['CITY_LOST', 'TARGET_LEFT', 'ISSUER_LOST_OFFICE'].map((cancelReason) => ({
      status: 'CANCELLED',
      resolvedBy: null,
      cancelReason,
    })),
  ];
  for (const [i, row] of terminal.entries())
    await insert(client, 'AssignmentOffer', {
      ...pending,
      ...row,
      id: `${400 + i}-1-2`,
      createdTick: 400 + i,
      resolvedTick: 500,
    });
  await db.assignmentOffer.create({ data: { ...pending, id: '600-1-2', createdTick: 600 } });
  expect(await db.assignmentOffer.count({ where: { worldId: 'one', targetGeneralId: 2 } })).toBe(8);
  await expect(insert(client, 'AssignmentOffer', { ...pending, id: 'invalid', status: 'OTHER' })).rejects.toMatchObject(
    { code: '22P02' },
  );
  // 국가·장수·도시 삭제 정책을 이력 FK로 정하지 않는다. World 경계만 DDL이 보장한다.
  const foreignKeys = (
    await client.query(`SELECT conname FROM pg_constraint
    WHERE conrelid='"AssignmentOffer"'::regclass AND contype='f' ORDER BY conname`)
  ).rows;
  expect(foreignKeys).toEqual([{ conname: 'AssignmentOffer_worldId_fkey' }]);
}

async function verifyLogs(client: PgClient, db: ReturnType<typeof createDb>) {
  const log = {
    worldId: 'one',
    generalId: 1,
    tick: 100,
    commandKey: 'personnel.appoint',
    kind: 'success',
    text: '임명 기록',
  };
  await expect(insert(client, 'GeneralLog', { ...log, ordinal: 9 })).rejects.toMatchObject({
    code: '23505',
    constraint: 'GeneralLog_worldId_generalId_tick_turn_key',
  });
  await db.generalLog.create({ data: { ...log, sequence: 10 } });
  await db.generalLog.create({ data: { ...log, sequence: 10, ordinal: 1 } });
  await db.generalLog.create({ data: { ...log, sequence: 11 } });
  await db.generalLog.create({ data: { ...log, generalId: 2, sequence: 10 } });
  await db.generalLog.create({ data: { ...log, worldId: 'two', sequence: 10 } });
  await expect(insert(client, 'GeneralLog', { ...log, tick: 999, sequence: 10 })).rejects.toMatchObject({
    code: '23505',
    constraint: 'GeneralLog_worldId_generalId_sequence_ordinal_key',
  });
  for (const sequence of [0, -1])
    await expect(insert(client, 'GeneralLog', { ...log, sequence })).rejects.toMatchObject({
      code: '23514',
      constraint: 'GeneralLog_sequence_check',
    });
  await expect(insert(client, 'GeneralLog', { ...log, sequence: 12, ordinal: -1 })).rejects.toMatchObject({
    code: '23514',
    constraint: 'GeneralLog_ordinal_check',
  });
  await expect(insert(client, 'GeneralLog', { ...log, sequence: 12, ordinal: null })).rejects.toMatchObject({
    code: '23502',
    column: 'ordinal',
  });
  expect(await db.generalLog.count({ where: { worldId: 'one', generalId: 1, tick: 100 } })).toBe(4);
  expect(
    await db.generalLog.findMany({
      where: { worldId: 'one', generalId: 1, tick: 100 },
      orderBy: { id: 'asc' },
      select: { sequence: true, ordinal: true },
    }),
  ).toEqual([
    { sequence: null, ordinal: 0 },
    { sequence: 10, ordinal: 0 },
    { sequence: 10, ordinal: 1 },
    { sequence: 11, ordinal: 0 },
  ]);
  const offerWhere = { worldId: 'one', id: '600-1-2', status: 'PENDING' as const };
  await expect(
    db.$transaction(async (tx) => {
      expect(
        (
          await tx.assignmentOffer.updateMany({
            where: offerWhere,
            data: { status: 'CANCELLED', cancelReason: 'CITY_LOST', resolvedTick: 601 },
          })
        ).count,
      ).toBe(1);
      await tx.generalLog.create({ data: { ...log, sequence: 30, commandKey: 'offer.cancel' } });
      throw new Error('저장 롤백 시험');
    }),
  ).rejects.toThrow('저장 롤백 시험');
  expect((await db.assignmentOffer.findFirstOrThrow({ where: offerWhere })).status).toBe('PENDING');
  expect(await db.generalLog.count({ where: { worldId: 'one', sequence: 30 } })).toBe(0);
}

it.each(['empty', 'legacy'] as const)(
  'T2-05 W1/W2 %s DB의 기존 행과 두 부분 색인·월드별 제안을 검증한다',
  async (mode) => {
    await withDatabase(mode, async (client, db) => {
      const directories = (await readdir(migrations)).filter((name) => /^\d/.test(name)).sort();
      const previous = directories.filter((name) => name < migration);
      expect(previous).toHaveLength(18);
      expect(previous.at(-1)).toBe(expectedHistoryEnd);
      expect(directories).toContain(migration);
      for (const directory of previous)
        await client.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'));
      if (mode === 'legacy') await seed(client);
      const before = await snapshot(client);
      await client.query(await readFile(new URL(`${migration}/migration.sql`, migrations), 'utf8'));
      expect(await snapshot(client)).toEqual(before);
      expect((await client.query('SELECT sequence, ordinal FROM "GeneralLog"')).rows).toEqual(
        mode === 'legacy' ? Array.from({ length: 4 }, () => ({ sequence: null, ordinal: 0 })) : [],
      );
      expect((await client.query('SELECT count(*)::int AS count FROM "AssignmentOffer"')).rows).toEqual([{ count: 0 }]);
      if (mode === 'empty') await seed(client);
      await verifyIndexes(client);
      await verifyOffers(client, db);
      await verifyLogs(client, db);
      expect(await db.world.deleteMany({ where: { id: 'one' } })).toEqual({ count: 1 });
      expect(await db.assignmentOffer.count({ where: { worldId: 'one' } })).toBe(0);
      expect(await db.assignmentOffer.count({ where: { worldId: 'two' } })).toBe(1);
    });
  },
);
