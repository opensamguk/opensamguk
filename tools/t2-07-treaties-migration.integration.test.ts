import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { testDatabaseUrl } from './test-database';

type PgClient = {
  connect(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pgRequire = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
const { Client } = pgRequire('pg') as { Client: new (config: { connectionString: string }) => PgClient };
const migration = '20261023073000_treaties';
const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);

async function withDatabase(mode: 'empty' | 'upgrade', run: (client: PgClient) => Promise<void>) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('조약 저장 전용 테스트 DB가 필요합니다.');
  const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  const name = `t207_treaty_${randomUUID().replaceAll('-', '')}_${mode}_test`;
  if (!/^t207_treaty_[a-f0-9]{32}_(empty|upgrade)_test$/.test(name))
    throw new Error('조약 시험 DB 이름이 올바르지 않습니다.');
  const target = new URL(source),
    adminUrl = new URL(source);
  target.pathname = `/${name}`;
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.href });
  const client = new Client({ connectionString: target.href });
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    console.info(`조약 시험 DB 생성 ${name}`);
    await client.connect();
    await run(client);
  } finally {
    try {
      await client.end();
      if (created) {
        expect(
          (await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows,
        ).toEqual([{ count: 0 }]);
        // 이 시험이 만든 UUID DB만 지운다. 다른 연결을 종료하거나 DROP FORCE를 쓰지 않는다.
        await admin.query(`DROP DATABASE "${name}"`);
        expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
        console.info(`조약 시험 DB 삭제 ${name}`);
      }
    } finally {
      await admin.end();
    }
  }
}

async function applyPreviousMigrations(client: PgClient) {
  const previous = (await readdir(migrations)).filter((name) => /^\d{14}_/.test(name) && name < migration).sort();
  expect(previous).toHaveLength(17);
  expect(previous.at(-1)).toBe('20261023072000_world_ext_slices');
  for (const name of previous) await client.query(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
}

async function insert(client: PgClient, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  if (![table, ...keys].every((key) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)))
    throw new Error('조약 시험 식별자가 올바르지 않습니다.');
  await client.query(
    `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  );
}

function world(id: string) {
  return {
    id,
    name: id,
    scenarioKey: 'treaty-storage-test',
    mapKey: 'treaty-storage-test',
    unitSetKey: 'treaty-storage-test',
    seed: 'treaty-storage-test',
    startYear: 191,
    turnTermMinutes: 1,
    initialStateHash: 'fixture-state-hash',
    statRules: '{}',
    unitSet: '{}',
  };
}

function treaty(worldId: string, id: number) {
  return {
    worldId,
    id,
    fromNationId: 91,
    toNationId: 92,
    clauses: JSON.stringify([{ kind: 'peace' }]),
    status: 'PROPOSED',
    proposedTick: 1500,
    respondByTick: 61500,
  };
}

async function assertCatalog(client: PgClient) {
  const columns = (
    await client.query(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema='public' AND table_name='Treaty'
       ORDER BY ordinal_position`,
    )
  ).rows;
  const expected = [
    ['worldId', 'text', 'text', 'NO'],
    ['id', 'integer', 'int4', 'NO'],
    ['fromNationId', 'integer', 'int4', 'NO'],
    ['toNationId', 'integer', 'int4', 'NO'],
    ['clauses', 'jsonb', 'jsonb', 'NO'],
    ['status', 'USER-DEFINED', 'TreatyStatus', 'NO'],
    ['proposedTick', 'integer', 'int4', 'NO'],
    ['respondByTick', 'integer', 'int4', 'NO'],
    ['startTick', 'integer', 'int4', 'YES'],
    ['endTick', 'integer', 'int4', 'YES'],
    ['closedSequence', 'integer', 'int4', 'YES'],
    ['costFrom', 'integer', 'int4', 'YES'],
    ['costTo', 'integer', 'int4', 'YES'],
  ].map(([column_name, data_type, udt_name, is_nullable]) => ({
    column_name,
    data_type,
    udt_name,
    is_nullable,
    column_default: null,
  }));
  expect(columns).toEqual(expected);
  expect(
    (
      await client.query(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema='public' AND table_name='World' AND column_name IN ('treatyFormat','treaties')`,
      )
    ).rows,
  ).toEqual([{ column_name: 'treatyFormat', data_type: 'integer', is_nullable: 'YES', column_default: null }]);
  expect((await client.query(`SELECT unnest(enum_range(NULL::"TreatyStatus"))::text AS status`)).rows).toEqual(
    ['PROPOSED', 'ACTIVE', 'REJECTED', 'EXPIRED', 'ENDED'].map((status) => ({ status })),
  );
  expect(
    (
      await client.query(
        `SELECT indexrel.relname AS name, i.indisunique AS "unique",
                array_agg(a.attname::text ORDER BY k.ordinality) AS columns
         FROM pg_index i JOIN pg_class indexrel ON indexrel.oid=i.indexrelid
         JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ordinality) ON true
         JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
         WHERE i.indrelid='"Treaty"'::regclass GROUP BY indexrel.relname,i.indisunique ORDER BY name`,
      )
    ).rows,
  ).toEqual([
    { name: 'Treaty_pkey', unique: true, columns: ['worldId', 'id'] },
    { name: 'Treaty_worldId_fromNationId_id_idx', unique: false, columns: ['worldId', 'fromNationId', 'id'] },
    { name: 'Treaty_worldId_status_id_idx', unique: false, columns: ['worldId', 'status', 'id'] },
    { name: 'Treaty_worldId_toNationId_id_idx', unique: false, columns: ['worldId', 'toNationId', 'id'] },
  ]);
  expect(
    (
      await client.query(
        `SELECT c.conname AS name, r.relname AS target, c.confdeltype::text AS "delete",
                c.confupdtype::text AS "update", pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid
         WHERE c.conrelid='"Treaty"'::regclass AND c.contype='f'`,
      )
    ).rows,
  ).toEqual([
    {
      name: 'Treaty_worldId_fkey',
      target: 'World',
      delete: 'c',
      update: 'c',
      definition: 'FOREIGN KEY ("worldId") REFERENCES "World"(id) ON UPDATE CASCADE ON DELETE CASCADE',
    },
  ]);
}

it('빈 DB에 조약 표만 더하고 키·필수 값·국가 이력·월드별 cascade를 지킨다', async () => {
  await withDatabase('empty', async (client) => {
    await applyPreviousMigrations(client);
    await client.query(await readFile(new URL(`${migration}/migration.sql`, migrations), 'utf8'));
    await assertCatalog(client);
    await insert(client, 'World', world('left'));
    await insert(client, 'World', world('right'));
    expect((await client.query('SELECT "treatyFormat" FROM "World" ORDER BY id')).rows).toEqual([
      { treatyFormat: null },
      { treatyFormat: null },
    ]);
    expect((await client.query('SELECT * FROM "Treaty"')).rows).toEqual([]);
    // 국가 행이 없어도 원 국가 ID를 저장한다. 조항 내용의 의미 검사는 런타임 몫이다.
    await insert(client, 'Treaty', treaty('left', 1));
    await insert(client, 'Treaty', treaty('right', 1));
    expect((await client.query('SELECT * FROM "Nation"')).rows).toEqual([]);
    const right = (await client.query('SELECT * FROM "Treaty" WHERE "worldId"=$1', ['right'])).rows;
    await expect(insert(client, 'Treaty', treaty('left', 1))).rejects.toMatchObject({
      code: '23505',
      constraint: 'Treaty_pkey',
    });
    await expect(insert(client, 'Treaty', treaty('missing', 2))).rejects.toMatchObject({
      code: '23503',
      constraint: 'Treaty_worldId_fkey',
    });
    for (const column of [
      'worldId',
      'id',
      'fromNationId',
      'toNationId',
      'clauses',
      'status',
      'proposedTick',
      'respondByTick',
    ]) {
      await expect(insert(client, 'Treaty', { ...treaty('left', 2), [column]: null })).rejects.toMatchObject({
        code: '23502',
        column,
      });
    }
    await expect(insert(client, 'Treaty', { ...treaty('left', 2), status: 'BROKEN' })).rejects.toMatchObject({
      code: '22P02',
    });
    await insert(client, 'Treaty', {
      ...treaty('left', 2),
      status: 'ACTIVE',
      startTick: 1500,
      endTick: null,
      closedSequence: null,
      costFrom: 0,
      costTo: 0,
    });
    expect(
      (await client.query('SELECT "endTick","closedSequence","costFrom","costTo" FROM "Treaty" WHERE id=2')).rows,
    ).toEqual([{ endTick: null, closedSequence: null, costFrom: 0, costTo: 0 }]);
    await insert(client, 'Treaty', { ...treaty('left', 3), clauses: 'null' });
    expect(
      (await client.query('SELECT clauses IS NULL AS "sqlNull",jsonb_typeof(clauses) AS type FROM "Treaty" WHERE id=3'))
        .rows,
    ).toEqual([{ sqlNull: false, type: 'null' }]);
    await insert(client, 'Nation', {
      worldId: 'left',
      id: 91,
      name: '사라질 국가',
      color: '#123456',
      gold: 0,
      rice: 0,
      description: '',
      tech: 0,
      philosophy: '',
      level: 1,
    });
    const left = (await client.query('SELECT * FROM "Treaty" WHERE "worldId"=$1 ORDER BY id', ['left'])).rows;
    await client.query('DELETE FROM "Nation" WHERE "worldId"=$1 AND id=91', ['left']);
    expect((await client.query('SELECT * FROM "Treaty" WHERE "worldId"=$1 ORDER BY id', ['left'])).rows).toEqual(left);
    await client.query('DELETE FROM "World" WHERE id=$1', ['left']);
    expect((await client.query('SELECT * FROM "Treaty" WHERE "worldId"=$1', ['left'])).rows).toEqual([]);
    expect((await client.query('SELECT * FROM "Treaty" WHERE "worldId"=$1', ['right'])).rows).toEqual(right);
    expect((await client.query('SELECT id,"treatyFormat" FROM "World"')).rows).toEqual([
      { id: 'right', treatyFormat: null },
    ]);
  });
}, 120_000);

it('기존 월드의 origin·F·해시·시계·sequence와 모든 기존 행을 보존하고 조약을 켜지 않는다', async () => {
  await withDatabase('upgrade', async (client) => {
    await applyPreviousMigrations(client);
    const archive = JSON.parse(
      await readFile(new URL('../apps/engine/test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
    ) as {
      origin: {
        initialStateHash: string;
        resourceHash: string;
        initial: {
          cities: Record<string, unknown>[];
          nations: Record<string, unknown>[];
          generals: Record<string, unknown>[];
        };
      };
    };
    for (const [index, id] of ['legacy', 'policy', 'capability'].entries()) {
      await insert(client, 'World', {
        ...world(id),
        status: ['PAUSED', 'RUNNING', 'ENDED'][index],
        clockTick: 60000 + index,
        monthlyTick: 60000,
        actionSequence: 42 + index,
        policyFromSequence: [null, 0, 9][index],
        initialStateHash: archive.origin.initialStateHash,
        replayOrigin: JSON.stringify(
          index === 2
            ? { ...archive.origin, version: 6, capabilities: { version: 1, personnel: { version: 1 } } }
            : archive.origin,
        ),
      });
    }
    await insert(client, 'User', { id: 't207-user', email: 't207@example.invalid', passwordHash: 'fixture-only' });
    for (const nation of archive.origin.initial.nations)
      await insert(client, 'Nation', { ...nation, worldId: 'legacy', capitalCityKey: null });
    for (const city of archive.origin.initial.cities) await insert(client, 'City', { ...city, worldId: 'legacy' });
    const general = archive.origin.initial.generals[0]!;
    await insert(client, 'General', {
      ...general,
      worldId: 'legacy',
      userId: 't207-user',
      defaultPolicy: 'farm',
      lastActiveTick: 1234,
      lastActiveAt: new Date('2026-10-01T00:00:00Z'),
    });
    for (let slot = 0; slot < 30; slot++)
      await insert(client, 'GeneralTurn', {
        worldId: 'legacy',
        generalId: general.id,
        slot,
        commandKey: 'rest',
        args: '{}',
        explicit: slot % 2 === 0,
      });
    await insert(client, 'InputEvent', {
      worldId: 'legacy',
      userId: 't207-user',
      generalId: general.id,
      kind: 'general.active',
      idempotencyKey: 'general.active:existing',
      payload: '{}',
      status: 'APPLIED',
      sequence: 41,
      result: '{"activeTick":1234}',
    });
    await insert(client, 'InputEvent', {
      worldId: 'legacy',
      userId: 't207-user',
      generalId: general.id,
      kind: 'general.setPolicy',
      idempotencyKey: 'general.setPolicy:pending',
      payload: '{"policy":"farm"}',
      status: 'PENDING',
    });
    await insert(client, 'WorldExtSlice', { worldId: 'capability', key: 'existing', value: 'null' });
    const tables = ['World', 'User', 'Nation', 'City', 'General', 'GeneralTurn', 'InputEvent', 'WorldExtSlice'];
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const table of tables)
        result[table] = (
          await client.query(`SELECT to_jsonb(t) - 'treatyFormat' AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)
        ).rows;
      return result;
    };
    const before = await snapshot();
    await client.query(await readFile(new URL(`${migration}/migration.sql`, migrations), 'utf8'));
    expect(await snapshot()).toEqual(before);
    expect((await client.query('SELECT id,"treatyFormat" FROM "World" ORDER BY id')).rows).toEqual([
      { id: 'capability', treatyFormat: null },
      { id: 'legacy', treatyFormat: null },
      { id: 'policy', treatyFormat: null },
    ]);
    expect((await client.query('SELECT * FROM "Treaty"')).rows).toEqual([]);
    await insert(client, 'World', world('new-unspecified'));
    expect((await client.query('SELECT "treatyFormat" FROM "World" WHERE id=$1', ['new-unspecified'])).rows).toEqual([
      { treatyFormat: null },
    ]);
    await assertCatalog(client);
  });
}, 120_000);
