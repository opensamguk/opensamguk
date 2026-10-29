import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';

type Row = Record<string, unknown>;
type PgClient = {
  connect(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => PgClient;
};
const marker = '20261027000000_treaty_break_trust';
const directory = new URL('../packages/db/prisma/migrations/', import.meta.url);
const previous23 = [
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
  '20261024000000_world_personnel_format',
  '20261025000000_input_event_step_tick',
  '20261026000000_game_resource',
];

const catalog = async (client: PgClient) =>
  (await client.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows;

async function ownDatabase(mode: 'empty' | 'upgrade' | 'constraints', run: (client: PgClient) => Promise<void>) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('파기 저장 시험 전용 DB가 필요합니다.');
  const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  const name = `t207_bt_${randomUUID().replaceAll('-', '')}_${mode}_test`;
  if (!/^t207_bt_[a-f0-9]{32}_(empty|upgrade|constraints)_test$/.test(name) || name.length > 63)
    throw new Error('파기 저장 시험 DB 이름을 확인하세요.');
  const target = new URL(source),
    adminUrl = new URL(source);
  target.pathname = `/${name}`;
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.href });
  const client = new Client({ connectionString: target.href });
  const errors: unknown[] = [];
  let created = false;
  let oid: string | undefined;
  await admin.connect();
  let before: Row[] | undefined;
  try {
    before = await catalog(admin);
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const identity = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows;
    expect(identity).toHaveLength(1);
    if (typeof identity[0]!.oid !== 'string') throw new Error('파기 저장 시험 DB OID를 확인하세요.');
    oid = identity[0]!.oid;
    console.info(JSON.stringify({ event: 't207-break-trust-created', name, oid }));
    await client.connect();
    await run(client);
  } catch (error) {
    errors.push(error);
  } finally {
    let disconnected = false;
    try {
      await client.end();
      disconnected = true;
    } catch (error) {
      errors.push(error);
    }
    try {
      if (created) {
        if (!oid || !disconnected) errors.push(new Error('파기 저장 시험 DB를 보존합니다.'));
        else {
          expect((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows).toEqual(
            [{ oid }],
          );
          const closed = await confirmDisconnectedDatabase(admin, name, oid);
          expect(closed.connections).toBe(0);
          await admin.query(`DROP DATABASE "${name}"`);
          expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
          console.info(JSON.stringify({ event: 't207-break-trust-dropped', name, oid, connections: 0, absent: true }));
        }
      }
      if (before) expect(await catalog(admin)).toEqual(before);
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await admin.end();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, '파기 저장 시험과 정리를 확인하세요.');
}

async function previous(client: PgClient) {
  const names = (await readdir(directory)).filter((name) => /^\d{14}_/.test(name)).sort();
  expect(names).toEqual([
    ...previous23,
    marker,
    '20261028000000_assignment_nation_destroyed',
    '20261029000000_general_residence_tick',
    '20261030000000_five_stats',
    '20261031000000_operational_map',
    '20261101000000_campaign_state',
    '20261102000000_account_tokens',
    '20261103000000_admin_role_audit',
    '20261104000000_account_world_sanctions',
    '20261105000000_admin_notices',
    '20261106000000_legal_document_versions',
    '20261107000000_admin_sanction_requests',
    '20261109000000_login_audit_records',
  ]);
  for (const name of previous23)
    await client.query(await readFile(new URL(`${name}/migration.sql`, directory), 'utf8'));
}
const migrate = async (client: PgClient) =>
  client.query(await readFile(new URL(`${marker}/migration.sql`, directory), 'utf8'));

async function insert(client: PgClient, table: string, row: Row) {
  const keys = Object.keys(row);
  if (![table, ...keys].every((key) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)))
    throw new Error('파기 저장 시험 식별자를 확인하세요.');
  await client.query(
    `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  );
}
const world = (id: string) => ({
  id,
  name: id,
  scenarioKey: 'trust-storage',
  mapKey: 'trust-storage',
  unitSetKey: 'trust-storage',
  seed: 'trust-storage',
  startYear: 191,
  turnTermMinutes: 1,
  initialStateHash: 'f'.repeat(64),
  statRules: '{}',
  unitSet: '{}',
});
const trust = (worldId: string, nationId = 7) => ({ worldId, nationId, brokenTreaties: 1, lastBrokenTick: 0 });

async function tables(client: PgClient) {
  return (
    await client.query(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
    )
  ).rows.map((row) => {
    if (typeof row.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(row.name))
      throw new Error('저장 표 이름을 확인하세요.');
    return row.name;
  });
}
async function snapshot(client: PgClient, names: string[]) {
  const rows: Record<string, unknown> = {};
  for (const name of names)
    rows[name] = (
      await client.query(`SELECT coalesce(jsonb_agg(data ORDER BY data::text),'[]'::jsonb) AS data
        FROM (SELECT to_jsonb(t) AS data FROM "${name}" t) s`)
    ).rows[0]!.data;
  return rows;
}

async function assertCatalog(client: PgClient) {
  expect((await client.query('SELECT unnest(enum_range(NULL::"TreatyStatus"))::text AS status')).rows).toEqual(
    ['PROPOSED', 'ACTIVE', 'REJECTED', 'EXPIRED', 'ENDED', 'BROKEN'].map((status) => ({ status })),
  );
  expect(
    (
      await client.query(
        `SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
         WHERE table_schema='public' AND table_name='NationTrust' ORDER BY ordinal_position`,
      )
    ).rows,
  ).toEqual(
    [
      ['worldId', 'text'],
      ['nationId', 'integer'],
      ['brokenTreaties', 'integer'],
      ['lastBrokenTick', 'integer'],
    ].map(([column_name, data_type]) => ({ column_name, data_type, is_nullable: 'NO', column_default: null })),
  );
  expect(
    (
      await client.query(
        `SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid='"NationTrust"'::regclass AND contype='c' ORDER BY conname`,
      )
    ).rows,
  ).toEqual([
    { name: 'NationTrust_brokenTreaties_check', definition: 'CHECK (("brokenTreaties" >= 1))' },
    { name: 'NationTrust_lastBrokenTick_check', definition: 'CHECK (("lastBrokenTick" >= 0))' },
    { name: 'NationTrust_nationId_check', definition: 'CHECK (("nationId" >= 1))' },
  ]);
  expect(
    (
      await client.query(
        `SELECT c.conname AS name,r.relname AS target,c.confdeltype::text AS "delete",c.confupdtype::text AS "update"
         FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid
         WHERE c.conrelid='"NationTrust"'::regclass AND c.contype='f'`,
      )
    ).rows,
  ).toEqual([{ name: 'NationTrust_worldId_fkey', target: 'World', delete: 'c', update: 'c' }]);
  expect(
    (
      await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='"NationTrust"'::regclass AND contype='p'`)
    ).rows,
  ).toEqual([{ definition: 'PRIMARY KEY ("worldId", "nationId")' }]);
  expect(
    (
      await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='World' AND column_name='nationTrust'`)
    ).rows,
  ).toEqual([]);
}

it('23번째 조약 파기 migration은 빈 신의 표와 파기 상태 하나를 더한다', async () => {
  await ownDatabase('empty', async (client) => {
    await previous(client);
    const before = await tables(client);
    await migrate(client);
    expect((await tables(client)).sort()).toEqual([...before, 'NationTrust'].sort());
    await assertCatalog(client);
    expect((await client.query('SELECT * FROM "NationTrust"')).rows).toEqual([]);
  });
});

it('23번째 migration 뒤에도 기존 다섯 조약 상태와 22개 migration의 저장 행은 같다', async () => {
  await ownDatabase('upgrade', async (client) => {
    await previous(client);
    await insert(client, 'World', world('upgrade-world'));
    await insert(client, 'Nation', {
      worldId: 'upgrade-world',
      id: 7,
      name: '기존 국가',
      color: '#112233',
      gold: 123,
      rice: 456,
      description: '기존 기록',
      tech: 1.25,
      philosophy: 'neutral',
      level: 1,
    });
    for (const [index, status] of ['PROPOSED', 'ACTIVE', 'REJECTED', 'EXPIRED', 'ENDED'].entries())
      await insert(client, 'Treaty', {
        worldId: 'upgrade-world',
        id: index + 1,
        fromNationId: 7,
        toNationId: 8,
        clauses: '[{"kind":"note","text":"기존 조약"}]',
        status,
        proposedTick: 0,
        respondByTick: 60000,
        startTick: status === 'ACTIVE' || status === 'ENDED' ? 1 : null,
        endTick: null,
        closedSequence: ['REJECTED', 'EXPIRED', 'ENDED'].includes(status) ? index + 10 : null,
        costFrom: status === 'ACTIVE' || status === 'ENDED' ? 0 : null,
        costTo: status === 'ACTIVE' || status === 'ENDED' ? 0 : null,
      });
    await insert(client, 'Message', {
      id: randomUUID(),
      worldId: 'upgrade-world',
      scope: 'WORLD',
      fromParty: '{}',
      body: '기존 알림',
      year: 191,
      month: 1,
    });
    await insert(client, 'InputEvent', {
      worldId: 'upgrade-world',
      userId: 'fixture-user',
      kind: 'treaty.propose',
      idempotencyKey: 'existing-input',
      payload: '{}',
    });
    await insert(client, 'GameResource', {
      id: randomUUID(),
      kind: 'MAP',
      name: 'existing',
      version: 1,
      status: 'PUBLISHED',
      content: '{"kept":true}',
      contentHash: 'a'.repeat(64),
      source: 'storage fixture',
      publishedAt: new Date('2026-10-01T00:00:00Z'),
    });
    const names = await tables(client);
    const before = await snapshot(client, names);
    await migrate(client);
    expect(await snapshot(client, names)).toEqual(before);
    expect((await client.query('SELECT * FROM "NationTrust"')).rows).toEqual([]);
    expect((await client.query('SELECT "personnelFormat" FROM "World"')).rows).toEqual([{ personnelFormat: null }]);
    expect((await client.query('SELECT "stepTick" FROM "InputEvent"')).rows).toEqual([{ stepTick: null }]);
    await assertCatalog(client);
    // 새 enum 값은 migration이 끝난 뒤 별도 query에서 쓴다.
    await insert(client, 'Treaty', {
      worldId: 'upgrade-world',
      id: 100,
      fromNationId: 7,
      toNationId: 8,
      clauses: '[{"kind":"peace"}]',
      status: 'BROKEN',
      proposedTick: 0,
      respondByTick: 60000,
      startTick: 1,
      endTick: null,
      closedSequence: 101,
      costFrom: 0,
      costTo: 0,
    });
    expect((await client.query('SELECT status::text FROM "Treaty" WHERE id=100')).rows).toEqual([{ status: 'BROKEN' }]);
  });
});

it('신의 저장은 세 CHECK와 월드 키·cascade를 지키고 멸망 국가의 기록을 남긴다', async () => {
  await ownDatabase('constraints', async (client) => {
    await previous(client);
    await migrate(client);
    await insert(client, 'World', world('world-a'));
    await insert(client, 'World', world('world-b'));
    await insert(client, 'Nation', {
      worldId: 'world-a',
      id: 7,
      name: '기록 국가',
      color: '#112233',
      gold: 0,
      rice: 0,
      description: '',
      tech: 0,
      philosophy: 'neutral',
      level: 1,
    });
    await insert(client, 'NationTrust', trust('world-a'));
    await insert(client, 'NationTrust', trust('world-b'));
    await insert(client, 'NationTrust', trust('world-a', 999));
    await insert(client, 'NationTrust', {
      ...trust('world-a', 2147483647),
      brokenTreaties: 2147483647,
      lastBrokenTick: 2147483647,
    });
    for (const [key, value, constraint] of [
      ['nationId', 0, 'NationTrust_nationId_check'],
      ['brokenTreaties', 0, 'NationTrust_brokenTreaties_check'],
      ['lastBrokenTick', -1, 'NationTrust_lastBrokenTick_check'],
    ] as const)
      await expect(insert(client, 'NationTrust', { ...trust('world-a', 1000), [key]: value })).rejects.toMatchObject({
        code: '23514',
        constraint,
      });
    for (const column of ['worldId', 'nationId', 'brokenTreaties', 'lastBrokenTick'])
      await expect(insert(client, 'NationTrust', { ...trust('world-a', 1000), [column]: null })).rejects.toMatchObject({
        code: '23502',
        column,
      });
    await expect(insert(client, 'NationTrust', trust('world-a'))).rejects.toMatchObject({
      code: '23505',
      constraint: 'NationTrust_pkey',
    });
    await expect(insert(client, 'NationTrust', trust('missing-world'))).rejects.toMatchObject({
      code: '23503',
      constraint: 'NationTrust_worldId_fkey',
    });
    await expect(
      insert(client, 'NationTrust', { ...trust('world-a', 1000), lastBrokenTick: 2147483648 }),
    ).rejects.toMatchObject({ code: '22003' });
    await client.query('DELETE FROM "Nation" WHERE "worldId"=$1 AND id=7', ['world-a']);
    expect(
      (await client.query('SELECT * FROM "NationTrust" WHERE "worldId"=$1 AND "nationId"=7', ['world-a'])).rows,
    ).toEqual([trust('world-a')]);
    await client.query('UPDATE "World" SET id=$1 WHERE id=$2', ['world-a-renamed', 'world-a']);
    expect(
      (await client.query('SELECT count(*)::int AS count FROM "NationTrust" WHERE "worldId"=$1', ['world-a-renamed']))
        .rows,
    ).toEqual([{ count: 3 }]);
    expect((await client.query('SELECT * FROM "NationTrust" WHERE "worldId"=$1', ['world-a'])).rows).toEqual([]);
    await client.query('DELETE FROM "World" WHERE id=$1', ['world-a-renamed']);
    expect((await client.query('SELECT * FROM "NationTrust"')).rows).toEqual([trust('world-b')]);
  });
});
