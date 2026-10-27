import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { testDatabaseUrl } from './test-database';

type Row = Record<string, unknown>;
type PgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => PgClient;
};
const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
const marker = '20261029000000_general_residence_tick';
const previous25 = [
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
  '20261027000000_treaty_break_trust',
  '20261028000000_assignment_nation_destroyed',
];

const catalog = async (client: PgClient) =>
  (await client.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows;

async function ownDatabase(
  mode: 'empty' | 'upgrade' | 'values',
  run: (client: PgClient, db: ReturnType<typeof createDb>) => Promise<void>,
) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('거주 tick 시험 접속값이 필요합니다.');
  let source: URL;
  try {
    // runner가 개발 DB와 분리한 뒤 전달한 시험 접속값만 다시 검사한다.
    source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  } catch {
    throw new Error('거주 tick 시험 접속값을 확인하세요.');
  }
  if (!['localhost', '127.0.0.1'].includes(source.hostname) || !['5432', '5433'].includes(source.port || '5432'))
    throw new Error('loopback 5432 또는 5433 시험 서버가 필요합니다.');
  for (const key of source.searchParams.keys())
    if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
      throw new Error('접속 대상 질의 인자는 쓸 수 없습니다.');
  const name = `t205_res_${randomUUID().replaceAll('-', '')}_${mode}_test`;
  if (!/^t205_res_[a-f0-9]{32}_(empty|upgrade|values)_test$/.test(name) || name.length > 63)
    throw new Error('자체 시험 DB 이름을 확인하세요.');
  const adminUrl = new URL(source),
    target = new URL(source);
  adminUrl.pathname = '/postgres';
  target.pathname = `/${name}`;
  const admin = new Client({ connectionString: adminUrl.href });
  const client = new Client({ connectionString: target.href });
  const db = createDb(target.href);
  const errors: unknown[] = [];
  let before: Row[] | undefined;
  let created = false,
    completed = false,
    dropped = false,
    adminClosed = false;
  let oid: string | undefined;
  let connections: number | undefined;
  await admin.connect();
  try {
    before = await catalog(admin);
    expect(before.some((row) => row.datname === name)).toBe(false);
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const identity = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows;
    expect(identity).toHaveLength(1);
    if (typeof identity[0]!.oid !== 'string') throw new Error('자체 시험 DB OID를 확인하세요.');
    oid = identity[0]!.oid;
    console.info(JSON.stringify({ event: 't205-residence-created', mode, name, oid }));
    await client.connect();
    expect((await readdir(migrations)).filter((item) => /^\d{14}_/.test(item)).sort()).toEqual([
      ...previous25,
      marker,
      '20261030000000_five_stats',
      '20261031000000_operational_map',
      '20261101000000_campaign_state',
    ]);
    await run(client, db);
    completed = true;
  } catch (error) {
    errors.push(error);
  } finally {
    const closed = await Promise.allSettled([client.end(), db.$disconnect()]);
    const ownClosed = closed.every((result) => result.status === 'fulfilled');
    for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
    try {
      if (created) {
        if (!oid || !ownClosed) errors.push(new Error('자체 시험 DB의 OID와 연결 종료를 확인하세요.'));
        else {
          expect((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows).toEqual(
            [{ oid }],
          );
          const active = (
            await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name])
          ).rows;
          if (typeof active[0]?.count === 'number') connections = active[0].count;
          expect(active).toEqual([{ count: 0 }]);
          await admin.query(`DROP DATABASE "${name}"`);
          dropped = true;
        }
      }
      if (before) expect(await catalog(admin)).toEqual(before);
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await admin.end();
        adminClosed = true;
      } catch (error) {
        errors.push(error);
      }
      console.info(
        JSON.stringify({
          event: 't205-residence-cleanup',
          mode,
          name,
          oid,
          completed,
          ownClosed,
          connections,
          dropped,
          adminClosed,
          leftDatabase: created && !dropped ? name : null,
          errors: errors.length,
        }),
      );
    }
  }
  if (errors.length) throw new AggregateError(errors, '거주 tick 시험과 DB 정리를 확인하세요.');
}

const apply = async (client: PgClient, name: string) =>
  client.query(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
async function applyPrevious(client: PgClient) {
  for (const name of previous25) await apply(client, name);
}
async function insert(client: PgClient, table: string, row: Row) {
  const keys = Object.keys(row);
  if (![table, ...keys].every((key) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)))
    throw new Error('시험 식별자를 확인하세요.');
  await client.query(
    `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')})`,
    Object.values(row),
  );
}
async function seed(client: PgClient) {
  const initial = commandInitial();
  const worldId = 'residence-world';
  await insert(client, 'World', {
    id: worldId,
    name: worldId,
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    seed: initial.seed,
    startYear: initial.startYear,
    turnTermMinutes: 30,
    initialStateHash: 'fixture',
    statRules: initial.statRules,
    unitSet: initial.unitSet,
  });
  await insert(client, 'User', {
    id: 'residence-human',
    email: 'residence-human@example.invalid',
    passwordHash: 'fixture-only',
  });
  for (const nation of initial.nations) await insert(client, 'Nation', { ...nation, worldId, capitalCityKey: null });
  for (const city of initial.cities) await insert(client, 'City', { ...city, worldId });
  for (const general of initial.generals.slice(0, 2))
    await insert(client, 'General', { ...general, worldId, userId: general.id === 1 ? 'residence-human' : null });
}

async function assertSchema(client: PgClient) {
  expect(
    (
      await client.query(
        `SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='General' AND column_name='residenceTick'`,
      )
    ).rows,
  ).toEqual([{ data_type: 'integer', is_nullable: 'YES', column_default: null }]);
  const constraints = (
    await client.query(
      `SELECT contype,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='"General"'::regclass AND conname='General_residenceTick_check'`,
    )
  ).rows;
  expect(constraints).toHaveLength(1);
  expect(constraints[0]).toMatchObject({ contype: 'c', convalidated: true });
  expect(String(constraints[0]!.definition)).toContain('"residenceTick" IS NULL');
  expect(String(constraints[0]!.definition)).toContain('"residenceTick" >= 0');
  expect(
    (await client.query('SELECT unnest(enum_range(NULL::"AssignmentOfferCancelReason"))::text AS reason')).rows,
  ).toEqual(['CITY_LOST', 'TARGET_LEFT', 'ISSUER_LOST_OFFICE', 'NATION_DESTROYED'].map((reason) => ({ reason })));
}

it('거주 tick migration은 빈 DB에 nullable 열과 CHECK를 더하고 멸망 취소 사유를 보존한다', async () => {
  await ownDatabase('empty', async (client) => {
    await applyPrevious(client);
    await apply(client, marker);
    await assertSchema(client);
    expect((await client.query('SELECT * FROM "General"')).rows).toEqual([]);
  });
});

it('거주 tick migration은 기존 사람과 NPC를 backfill하지 않고 모든 기존 칸을 보존한다', async () => {
  await ownDatabase('upgrade', async (client, db) => {
    await applyPrevious(client);
    await seed(client);
    const before = (await client.query('SELECT to_jsonb(t) AS row FROM "General" t ORDER BY id')).rows;
    expect(before).toHaveLength(2);
    await apply(client, marker);
    expect(
      (await client.query('SELECT to_jsonb(t) - \'residenceTick\' AS row FROM "General" t ORDER BY id')).rows,
    ).toEqual(before);
    expect(
      await db.general.findMany({ select: { id: true, userId: true, residenceTick: true }, orderBy: { id: 'asc' } }),
    ).toEqual([
      { id: 1, userId: 'residence-human', residenceTick: null },
      { id: 2, userId: null, residenceTick: null },
    ]);
    await assertSchema(client);
  });
});

it('거주 tick은 null·0·양수를 저장하고 음수를 거부하며 멸망 취소 사유를 실제로 쓴다', async () => {
  await ownDatabase('values', async (client, db) => {
    await applyPrevious(client);
    await seed(client);
    await apply(client, marker);
    await apply(client, '20261030000000_five_stats');
    await apply(client, '20261031000000_operational_map');
    await apply(client, '20261101000000_campaign_state');
    expect((await client.query('SELECT id FROM "World" WHERE "operationalMap" IS NOT NULL')).rows).toEqual([]);
    expect((await client.query('SELECT id FROM "World" WHERE "campaignState" IS NOT NULL')).rows).toEqual([]);
    expect((await client.query('SELECT "cityKey" FROM "City" WHERE "kind" IS NOT NULL')).rows).toEqual([]);
    expect(
      (await client.query('SELECT id FROM "General" WHERE "politics" IS NOT NULL OR "charm" IS NOT NULL')).rows,
    ).toEqual([]);
    const where = { worldId_id: { worldId: 'residence-world', id: 1 } };
    for (const residenceTick of [0, 1, 2147483647, null]) {
      expect((await db.general.update({ where, data: { residenceTick } })).residenceTick).toBe(residenceTick);
      expect(
        (await client.query('SELECT "residenceTick" FROM "General" WHERE "worldId"=$1 AND id=1', ['residence-world']))
          .rows,
      ).toEqual([{ residenceTick }]);
    }
    await db.general.update({ where, data: { residenceTick: 105 } });
    const before = await db.general.findUniqueOrThrow({ where });
    await expect(
      client.query('UPDATE "General" SET "residenceTick"=-1 WHERE "worldId"=$1 AND id=1', ['residence-world']),
    ).rejects.toMatchObject({ code: '23514', constraint: 'General_residenceTick_check' });
    expect(await db.general.findUniqueOrThrow({ where })).toEqual(before);
    const offer = await db.assignmentOffer.create({
      data: {
        worldId: 'residence-world',
        id: 'destroyed',
        nationId: 1,
        issuerGeneralId: 1,
        targetGeneralId: 2,
        cityKey: 1,
        status: 'CANCELLED',
        cancelReason: 'NATION_DESTROYED',
        createdTick: 0,
        expiresTick: 1,
        resolvedTick: 0,
      },
    });
    expect(offer.cancelReason).toBe('NATION_DESTROYED');
    expect(
      (await client.query('SELECT "cancelReason"::text AS reason FROM "AssignmentOffer" WHERE id=$1', ['destroyed']))
        .rows,
    ).toEqual([{ reason: 'NATION_DESTROYED' }]);
  });
});
