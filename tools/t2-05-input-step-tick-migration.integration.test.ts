import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { testDatabaseUrl } from './test-database';

type PgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
type Catalog = { datname: string; oid: string }[];
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(dbRequire.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => PgClient;
};
const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
const marker = '20261025000000_input_event_step_tick';
const required21 = [
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
];

async function catalog(admin: PgClient): Promise<Catalog> {
  return (await admin.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows.map((row) => {
    if (typeof row.datname !== 'string' || typeof row.oid !== 'string') throw new Error('DB 목록을 확인하세요.');
    return { datname: row.datname, oid: row.oid };
  });
}

async function column(client: PgClient) {
  return (
    await client.query(
      `SELECT data_type,udt_name,is_nullable,column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='InputEvent' AND column_name='stepTick'`,
    )
  ).rows;
}

async function snapshot(client: PgClient, columns?: string[]) {
  // 저장된 JSONB 원문과 기존 모든 칸을 비교한다. 뒤에 생긴 칸은 허용한다.
  const row = columns
    ? '(SELECT jsonb_object_agg(key,value) FROM jsonb_each(to_jsonb(t)) WHERE key=ANY($1::text[]))'
    : 'to_jsonb(t)';
  return (
    await client.query(
      `SELECT (${row})::text AS row,
         payload::text AS payload,result::text AS result
       FROM "InputEvent" t WHERE "idempotencyKey" LIKE 'old-%' ORDER BY id`,
      columns ? [columns] : [],
    )
  ).rows;
}

async function seed(client: PgClient) {
  await client.query(`INSERT INTO "World"
    (id,name,"scenarioKey","mapKey","unitSetKey",seed,"startYear","turnTermMinutes",
     "initialStateHash","statRules","unitSet")
    VALUES ('tick-world','tick-world','fixture','fixture','fixture','fixture',180,30,'fixture','{}','{}')`);
  for (const [index, status] of ['PENDING', 'REJECTED', 'APPLIED'].entries()) {
    await client.query(
      `INSERT INTO "InputEvent"
       ("worldId","userId",kind,"idempotencyKey",payload,status,sequence,result,"createdAt")
       VALUES ('tick-world','fixture-user',$1,$2,$3::jsonb,$4::"InputEventStatus",$5,$6::jsonb,
         '2026-10-20 12:34:56.789'::timestamp)`,
      [
        index === 2 ? 'nationTurns.set' : 'general.create',
        `old-${status}`,
        '{"name":"기존 입력","nested":[null,0,{"value":"보존"}]}',
        status,
        status === 'PENDING' ? null : index + 1,
        status === 'PENDING' ? null : status === 'APPLIED' ? '{"revision":7}' : '{"code":"WORLD_CLOSED"}',
      ],
    );
  }
}

async function verifyValues(client: PgClient, db: ReturnType<typeof createDb>) {
  const data = {
    worldId: 'tick-world',
    userId: 'fixture-user',
    kind: 'general.create',
    payload: { untouched: [0, null, '원문'] },
  };
  for (const [index, status] of (['PENDING', 'REJECTED', 'APPLIED'] as const).entries()) {
    const row = await db.inputEvent.create({
      data: {
        ...data,
        status,
        idempotencyKey: `null-${status}`,
        ...(status === 'PENDING' ? {} : { sequence: 10 + index, result: {} }),
      },
    });
    expect(row.stepTick).toBeNull();
  }
  for (const [index, kind] of ['general.create', 'nationTurns.set'].entries()) {
    const row = await db.inputEvent.create({
      data: {
        ...data,
        kind,
        idempotencyKey: `zero-${kind}`,
        status: 'APPLIED',
        sequence: 20 + index,
        result: {},
        stepTick: 0,
      },
    });
    expect(row.stepTick).toBe(0);
    expect(
      (
        await client.query('SELECT "stepTick","stepTick" IS NULL AS "isNull" FROM "InputEvent" WHERE id=$1', [
          row.id.toString(),
        ])
      ).rows,
    ).toEqual([{ stepTick: 0, isNull: false }]);
  }
  const maximum = await db.inputEvent.create({
    data: { ...data, idempotencyKey: 'maximum', status: 'APPLIED', sequence: 30, result: {}, stepTick: 2147483647 },
  });
  expect(maximum.stepTick).toBe(2147483647);

  for (const [index, [status, tick]] of (
    [
      ['PENDING', 0],
      ['PENDING', 1],
      ['REJECTED', 0],
      ['REJECTED', 1],
      ['APPLIED', -1],
    ] as const
  ).entries()) {
    await expect(
      client.query(
        `INSERT INTO "InputEvent" ("worldId","userId",kind,"idempotencyKey",payload,status,"stepTick",sequence,result)
         VALUES ('tick-world','fixture-user','general.create',$1,'{}',$2::"InputEventStatus",$3,$4,$5::jsonb)`,
        [
          `invalid-${status}-${tick}`,
          status,
          tick,
          status === 'PENDING' ? null : 100 + index,
          status === 'PENDING' ? null : '{}',
        ],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'InputEvent_stepTick_check' });
  }
  expect(await db.inputEvent.count({ where: { idempotencyKey: { startsWith: 'invalid-' } } })).toBe(0);

  const pending = await db.inputEvent.findFirstOrThrow({ where: { idempotencyKey: 'old-PENDING' } });
  for (const patch of ['"stepTick"=0', "status='APPLIED',sequence=90,result='{}'::jsonb,\"stepTick\"=-1"]) {
    await expect(
      client.query(`UPDATE "InputEvent" SET ${patch} WHERE id=$1`, [pending.id.toString()]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'InputEvent_stepTick_check',
    });
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(pending);
  }

  // 상태·sequence·result·tick과 World 변경이 같은 트랜잭션에서 함께 되돌아간다.
  const world = await db.world.findUniqueOrThrow({ where: { id: 'tick-world' } });
  await expect(
    db.$transaction(async (tx) => {
      await tx.world.update({ where: { id: world.id }, data: { actionSequence: 50 } });
      const updated = await tx.inputEvent.update({
        where: { id: pending.id },
        data: { status: 'APPLIED', sequence: 50, result: { general: 'rollback' }, stepTick: 0 },
      });
      expect(updated.stepTick).toBe(0);
      throw new Error('입력 tick 롤백 시험');
    }),
  ).rejects.toThrow('입력 tick 롤백 시험');
  expect(await db.inputEvent.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(pending);
  expect(await db.world.findUniqueOrThrow({ where: { id: world.id } })).toEqual(world);
}

it('T2-05 N4 입력 tick migration은 기존 행·null·0을 보존하고 CHECK와 롤백을 지킨다', async () => {
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
  const name = `t205_input_tick_${randomUUID().replaceAll('-', '')}_test`;
  if (!/^t205_input_tick_[a-f0-9]{32}_test$/.test(name)) throw new Error('자체 DB 이름을 확인하세요.');
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
    dropped = false,
    adminClosed = false;
  let createdOid: string | null = null,
    connectionsBeforeDrop: number | null = null;
  let before: Catalog = [],
    after: Catalog | null = null;
  let bodyFailed = false,
    cleanupFailed = false;
  let bodyError: unknown, cleanupError: unknown;
  const applied: string[] = [];
  try {
    await admin.connect();
    adminConnected = true;
    before = await catalog(admin);
    if (before.some((row) => row.datname === name)) throw new Error('자체 시험 DB가 이미 있습니다.');
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    createdOid = (await catalog(admin)).find((row) => row.datname === name)?.oid ?? null;
    console.info('T2-05 입력 tick DB 생성', JSON.stringify({ name, createdOid }));
    expect(createdOid).not.toBeNull();
    await client.connect();
    const directories = (await readdir(migrations)).filter((directory) => /^\d{14}_/.test(directory)).sort();
    expect(directories.slice(0, required21.length)).toEqual(required21);
    expect(directories[required21.length]).toBe(marker);
    async function apply(directory: string) {
      await client.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'));
      applied.push(directory);
    }
    for (const directory of required21) await apply(directory);
    expect(await column(client)).toEqual([]);
    await seed(client);
    const old = await snapshot(client);
    expect(old).toHaveLength(3);
    const oldColumns = Object.keys(JSON.parse(String(old[0]!.row)) as Record<string, unknown>);
    await apply(marker);
    expect(await column(client)).toEqual([
      { data_type: 'integer', udt_name: 'int4', is_nullable: 'YES', column_default: null },
    ]);
    const constraints = (
      await client.query(`SELECT contype,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='"InputEvent"'::regclass AND conname='InputEvent_stepTick_check'`)
    ).rows;
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatchObject({ contype: 'c', convalidated: true });
    expect(String(constraints[0]!.definition)).toContain('"stepTick" IS NULL');
    expect(String(constraints[0]!.definition)).toContain('status = \'APPLIED\'::"InputEventStatus"');
    expect(String(constraints[0]!.definition)).toContain('"stepTick" >= 0');
    expect(await snapshot(client, oldColumns)).toEqual(old);
    for (const directory of directories.slice(required21.length + 1)) await apply(directory);
    expect(await snapshot(client, oldColumns)).toEqual(old);
    expect((await client.query('SELECT "stepTick" FROM "InputEvent" ORDER BY id')).rows).toEqual([
      { stepTick: null },
      { stepTick: null },
      { stepTick: null },
    ]);
    db = createDb(target.href);
    const rows = await db.inputEvent.findMany({ orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.stepTick === null)).toBe(true);
    await verifyValues(client, db);
    expect(await snapshot(client, oldColumns)).toEqual(old);
    expect(applied).toEqual(directories);
    completed = true;
    console.info(
      'T2-05 입력 tick migration',
      JSON.stringify({
        name,
        applied,
        requiredPrefix: required21.length,
        marker,
        tailCount: directories.length - required21.length - 1,
        preservedRows: old.length,
        zeroKinds: ['general.create', 'nationTurns.set'],
        rejectedWrites: 7,
        transactionRollback: true,
      }),
    );
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
        'T2-05 입력 tick DB 정리',
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
