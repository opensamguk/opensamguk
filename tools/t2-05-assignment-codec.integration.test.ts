import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { toWorldState, type ClosedOffer, type WorldInit, type WorldState } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import {
  loadAssignmentState,
  persistAssignmentState,
  type AssignmentSnapshot,
} from '../apps/engine/src/assignmentState';
import { loadOfficeState, persistOfficeState } from '../apps/engine/src/personnelState';
import { testDatabaseUrl } from './test-database';

type PgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
type Db = ReturnType<typeof createDb>;
type Catalog = { datname: string; oid: string }[];
type CaseId = `g${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;
type Offer = NonNullable<WorldState['assignmentOffers']>[number];
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pgRequire = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
const { Client } = pgRequire('pg') as { Client: new (config: { connectionString: string }) => PgClient };
const worldId = 'codec-sql-fixture';
const original: Offer = {
  id: 'opaque:original',
  nationId: 1,
  issuerGeneralId: 1,
  cityKey: 1,
  createdTick: 100,
  expiresTick: 900,
};
const next: Offer = { ...original, id: 'opaque:next', createdTick: 200 };
const empty: AssignmentSnapshot = {};
const requiredMigrations = [
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
] as const;

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value) || value.length > 63) throw new Error('시험 DB 식별자를 확인하세요.');
  return `"${value}"`;
}

async function catalog(client: PgClient): Promise<Catalog> {
  const { rows } = await client.query('SELECT datname, oid::text AS oid FROM pg_database ORDER BY datname');
  return rows.map(({ datname, oid }) => {
    if (typeof datname !== 'string' || typeof oid !== 'string') throw new Error('DB 목록을 확인하세요.');
    return { datname, oid };
  });
}

type Context = { sql: PgClient; db: Db; initial: WorldInit; openSql(): Promise<PgClient>; openDb(): Db };

// 원본 URL의 DB에는 연결하지 않는다. postgres와 내부 UUID로 만든 DB에만 연결한다.
async function withDatabase(caseId: CaseId, run: (context: Context) => Promise<void>) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL이 필요합니다.');
  const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  const name = `t205_assignment_codec_${caseId}_${randomUUID().replaceAll('-', '')}_test`;
  identifier(name);
  if (name === source.pathname.slice(1)) throw new Error('원본 URL의 DB 이름은 사용할 수 없습니다.');
  const adminUrl = new URL(source),
    target = new URL(source);
  adminUrl.pathname = '/postgres';
  target.pathname = `/${name}`;
  const admin = new Client({ connectionString: adminUrl.href });
  const clients: PgClient[] = [];
  const pools: Db[] = [];
  let before: Catalog = [];
  let createdOid: string | null = null;
  let created = false,
    connected = false,
    completed = false,
    dropped = false;
  let connectionsBeforeDrop: number | null = null;
  let failure: unknown;
  let failed = false;
  const cleanupErrors: unknown[] = [];
  try {
    await admin.connect();
    connected = true;
    before = await catalog(admin);
    if (before.some((row) => row.datname === name)) throw new Error('새 시험 DB 이름이 이미 있습니다.');
    await admin.query(`CREATE DATABASE ${identifier(name)}`);
    created = true;
    createdOid = (await catalog(admin)).find((row) => row.datname === name)?.oid ?? null;
    expect(createdOid).not.toBeNull();
    console.info('발령 codec 시험 DB 생성', JSON.stringify({ caseId, name, createdOid }));
    const openSql = async () => {
      const client = new Client({ connectionString: target.href });
      clients.push(client);
      await client.connect();
      return client;
    };
    const openDb = () => {
      const db = createDb(target.href);
      pools.push(db);
      return db;
    };
    const sql = await openSql();
    const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
    const directories = (await readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories.slice(0, requiredMigrations.length)).toEqual([...requiredMigrations]);
    for (const directory of directories)
      await sql.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'));
    const archive = JSON.parse(
      await readFile(new URL('../apps/engine/test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
    ) as {
      origin: { initial: WorldInit; initialStateHash: string };
    };
    const initial = archive.origin.initial;
    await insert(sql, 'World', {
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
    });
    await insert(sql, 'Nation', { ...initial.nations[0]!, worldId, id: 1, capitalCityKey: null });
    await insert(sql, 'City', { ...initial.cities[0]!, worldId, cityKey: 1, nationId: 1, connections: [] });
    await insert(sql, 'General', { ...initial.generals[0]!, worldId, id: 1, userId: null, nationId: 1, cityKey: 1 });
    await run({ sql, db: openDb(), initial, openSql, openDb });
    completed = true;
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    const closed = await Promise.allSettled([
      ...clients.map((client) => client.end()),
      ...pools.map((db) => db.$disconnect()),
    ]);
    for (const result of closed) if (result.status === 'rejected') cleanupErrors.push(result.reason);
    let after: Catalog | null = null;
    try {
      if (created) {
        expect(cleanupErrors, '자체 연결과 pool 종료').toHaveLength(0);
        expect((await catalog(admin)).find((row) => row.datname === name)).toEqual({ datname: name, oid: createdOid });
        const count = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name]);
        expect(count.rows).toEqual([{ count: 0 }]);
        connectionsBeforeDrop = 0;
        await admin.query(`DROP DATABASE ${identifier(name)}`);
        dropped = true;
      }
      if (connected) {
        after = await catalog(admin);
        for (const row of before) expect(after).toContainEqual(row);
        if (created) expect(after.some((row) => row.datname === name)).toBe(false);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    console.info(
      '발령 codec 시험 DB 정리',
      JSON.stringify({
        caseId,
        name,
        created,
        createdOid,
        completed,
        connectionsBeforeDrop,
        dropped,
        before,
        after,
        cleanupFailures: cleanupErrors.length,
        existingDatabaseConnectionsOpened: 0,
        forcedConnectionTermination: 0,
      }),
    );
    try {
      await admin.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors, '시험 DB 정리를 확인하세요.');
  if (failed) throw failure;
}

async function insert(sql: PgClient, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  // 표와 열은 이 파일의 고정 fixture만 넘긴다. 값은 모두 바인딩한다.
  return sql.query(
    `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')})`,
    Object.values(row),
  );
}

function snapshot(offer = original, target = 7): AssignmentSnapshot {
  return { assignmentOffers: { [target]: offer } };
}
function accepted(offer = original): ClosedOffer {
  return { id: offer.id, status: 'ACCEPTED', resolvedBy: 'RESPONSE', cancelReason: null, resolvedTick: 200 };
}
function cancelled(offer = next): ClosedOffer {
  return { id: offer.id, status: 'CANCELLED', resolvedBy: null, cancelReason: 'CITY_LOST', resolvedTick: 200 };
}
async function seedOffer(db: Db, offer = original, targetGeneralId = 7) {
  await db.assignmentOffer.create({ data: { worldId, targetGeneralId, ...offer, status: 'PENDING' } });
}
async function lock(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT id FROM "World" WHERE id=${worldId} FOR UPDATE`;
}
async function action<T>(db: Db, run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await lock(tx);
      return run(tx);
    },
    { isolationLevel: 'ReadCommitted' },
  );
}
async function rows(sql: PgClient) {
  const result: Record<string, unknown> = {};
  for (const table of ['NationOffice', 'NationOfficeTurn', 'AssignmentOffer', 'GeneralLog'])
    result[table] = (
      await sql.query(`SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)
    ).rows;
  return result;
}
async function seedOffice(sql: PgClient) {
  await insert(sql, 'NationOffice', { worldId, nationId: 1, officerLevel: 5, turnRevision: 7, tenure: 3 });
  await insert(sql, 'NationOfficeTurn', {
    worldId,
    nationId: 1,
    officerLevel: 5,
    slot: 0,
    commandKey: 'nation_rest',
    args: { preserved: true },
  });
}

// 실제 DB에 호출을 넘기고 결과를 바꾸지 않은 채 순서와 count를 기록한다.
function observe(
  tx: Prisma.TransactionClient,
  calls: string[],
  beforeUpdate?: () => Promise<void>,
): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, key) {
      if (key !== 'assignmentOffer') return Reflect.get(target, key);
      const delegate = target.assignmentOffer;
      return new Proxy(delegate, {
        get(current, method) {
          if (method === 'create')
            return async (...args: Parameters<typeof delegate.create>) => {
              const result = await delegate.create(...args);
              calls.push(`create:${result.id}`);
              return result;
            };
          if (method === 'updateMany')
            return async (...args: Parameters<typeof delegate.updateMany>) => {
              await beforeUpdate?.();
              const result = await delegate.updateMany(...args);
              calls.push(`close:${String(args[0]?.where?.id)}:${result.count}`);
              return result;
            };
          return Reflect.get(current, method);
        },
      });
    },
  });
}

it('G1 PENDING 부분 유일 색인과 종료 뒤 새 제안을 확인한다', async () =>
  withDatabase('g1', async ({ db }) => {
    await seedOffer(db);
    await expect(seedOffer(db, next)).rejects.toMatchObject({ code: 'P2002' });
    await action(db, async (tx) => {
      const before = await loadAssignmentState(tx, worldId);
      await persistAssignmentState(tx, worldId, {
        before,
        beforeFinish: empty,
        final: empty,
        closedOffers: [accepted()],
      });
    });
    await action(db, async (tx) =>
      persistAssignmentState(tx, worldId, {
        before: empty,
        beforeFinish: snapshot(next),
        final: snapshot(next),
        closedOffers: [],
      }),
    );
    expect(
      await db.assignmentOffer.findMany({
        where: { worldId },
        orderBy: { createdTick: 'asc' },
        select: { id: true, status: true },
      }),
    ).toEqual([
      { id: original.id, status: 'ACCEPTED' },
      { id: next.id, status: 'PENDING' },
    ]);
  }));

it('G2 잘못된 교체 순서는 롤백되고 a·b·c 순서는 성공한다', async () =>
  withDatabase('g2', async ({ db }) => {
    await seedOffer(db);
    await expect(
      action(db, async (tx) => {
        await tx.world.update({ where: { id: worldId }, data: { actionSequence: 1 } });
        await tx.assignmentOffer.create({ data: { worldId, targetGeneralId: 7, ...next, status: 'PENDING' } });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).actionSequence).toBe(0);
    expect(await loadAssignmentState(db, worldId)).toEqual(snapshot());
    const calls: string[] = [];
    await action(db, async (tx) => {
      const before = await loadAssignmentState(tx, worldId);
      await persistAssignmentState(observe(tx, calls), worldId, {
        before,
        beforeFinish: snapshot(next),
        final: empty,
        closedOffers: [
          { id: original.id, status: 'SUPERSEDED', resolvedBy: null, cancelReason: null, resolvedTick: 200 },
          cancelled(),
        ],
      });
    });
    expect(calls).toEqual([`close:${original.id}:1`, `create:${next.id}`, `close:${next.id}:1`]);
    expect(
      await db.assignmentOffer.findMany({
        where: { worldId },
        orderBy: { createdTick: 'asc' },
        select: { id: true, status: true },
      }),
    ).toEqual([
      { id: original.id, status: 'SUPERSEDED' },
      { id: next.id, status: 'CANCELLED' },
    ]);
  }));

it('G3 같은 step에서 생성하고 취소한 제안을 원본 증인으로 저장한다', async () =>
  withDatabase('g3', async ({ db }) => {
    const calls: string[] = [];
    await action(db, async (tx) =>
      persistAssignmentState(observe(tx, calls), worldId, {
        before: empty,
        beforeFinish: snapshot(next),
        final: empty,
        closedOffers: [cancelled()],
      }),
    );
    expect(calls).toEqual([`create:${next.id}`, `close:${next.id}:1`]);
    expect(await db.assignmentOffer.findMany({ where: { worldId } })).toEqual([
      {
        worldId,
        targetGeneralId: 7,
        ...next,
        status: 'CANCELLED',
        resolvedBy: null,
        cancelReason: 'CITY_LOST',
        resolvedTick: 200,
      },
    ]);
    expect(await loadAssignmentState(db, worldId)).toEqual(empty);
  }));

it('G4 종료 행은 그대로 두고 외부 결함 주입의 실제 count 0을 거부한다', async () =>
  withDatabase('g4', async ({ db, openSql }) => {
    await seedOffer(db);
    await action(db, async (tx) =>
      persistAssignmentState(tx, worldId, {
        before: snapshot(),
        beforeFinish: empty,
        final: empty,
        closedOffers: [accepted()],
      }),
    );
    const terminal = await db.assignmentOffer.findMany({ where: { worldId } });
    const staleCalls: string[] = [];
    await expect(
      action(db, async (tx) =>
        persistAssignmentState(observe(tx, staleCalls), worldId, {
          before: snapshot(),
          beforeFinish: empty,
          final: empty,
          closedOffers: [accepted()],
        }),
      ),
    ).rejects.toThrow('before');
    expect(staleCalls).toEqual([]);
    expect(await db.assignmentOffer.findMany({ where: { worldId } })).toEqual(terminal);
    const faultOffer = { ...next, id: 'opaque:g4-fault' };
    await seedOffer(db, faultOffer, 9);
    const external = await openSql();
    const calls: string[] = [];
    let injected = false;
    await expect(
      action(db, async (tx) => {
        const before = await loadAssignmentState(tx, worldId);
        await tx.world.update({ where: { id: worldId }, data: { actionSequence: 1 } });
        const traced = observe(tx, calls, async () => {
          expect(injected).toBe(false);
          injected = true;
          // World 잠금을 일부러 잡지 않는 외부 쓰기다. 정상 운영 경로의 동시성 증거가 아니다.
          const changed = await external.query(
            'UPDATE "AssignmentOffer" SET status=\'REJECTED\', "resolvedBy"=\'RESPONSE\', "resolvedTick"=220 WHERE "worldId"=$1 AND id=$2 AND status=\'PENDING\' RETURNING id',
            [worldId, faultOffer.id],
          );
          expect(changed.rows).toEqual([{ id: faultOffer.id }]);
        });
        await persistAssignmentState(traced, worldId, {
          before,
          beforeFinish: empty,
          final: empty,
          closedOffers: [accepted(faultOffer)],
        });
      }),
    ).rejects.toThrow('한 행');
    expect(calls).toEqual([`close:${faultOffer.id}:0`]);
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).actionSequence).toBe(0);
    expect(
      await db.assignmentOffer.findUniqueOrThrow({ where: { worldId_id: { worldId, id: faultOffer.id } } }),
    ).toMatchObject({ status: 'REJECTED', resolvedBy: 'RESPONSE', resolvedTick: 220 });
    expect(await db.assignmentOffer.findUniqueOrThrow({ where: { worldId_id: { worldId, id: original.id } } })).toEqual(
      terminal[0],
    );
  }));

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('G5 World 잠금 뒤 fresh before는 쓰기 0이며 낡은 B는 거부한다', async () =>
  withDatabase('g5', async ({ db, openDb, openSql }) => {
    await seedOffer(db);
    const other = openDb(),
      probe = await openSql();
    const ready = latch(),
      release = latch(),
      attempted = latch();
    const calls: string[] = [];
    let stale: AssignmentSnapshot = empty;
    const first = action(db, async (tx) => {
      stale = await loadAssignmentState(tx, worldId);
      ready.release();
      await release.promise;
      await persistAssignmentState(tx, worldId, {
        before: stale,
        beforeFinish: empty,
        final: empty,
        closedOffers: [accepted()],
      });
    });
    let second: Promise<void> | undefined;
    try {
      await Promise.race([
        ready.promise,
        first.then(() => {
          throw new Error('첫 잠금 전에 트랜잭션이 끝났습니다.');
        }),
      ]);
      await probe.query('BEGIN');
      try {
        await expect(
          probe.query('SELECT id FROM "World" WHERE id=$1 FOR UPDATE NOWAIT', [worldId]),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await probe.query('ROLLBACK');
      }
      second = other.$transaction(
        async (tx) => {
          attempted.release();
          await lock(tx);
          const before = await loadAssignmentState(tx, worldId);
          expect(before).toEqual(empty);
          await persistAssignmentState(observe(tx, calls), worldId, {
            before,
            beforeFinish: before,
            final: before,
            closedOffers: [],
          });
        },
        { isolationLevel: 'ReadCommitted' },
      );
      await Promise.race([
        attempted.promise,
        second.then(() => {
          throw new Error('두 번째 잠금 시도 전에 끝났습니다.');
        }),
      ]);
      release.release();
      await Promise.all([first, second]);
    } finally {
      release.release();
      await Promise.allSettled(second ? [first, second] : [first]);
    }
    expect(calls).toEqual([]);
    const committed = await db.assignmentOffer.findMany({ where: { worldId } });
    await expect(
      action(other, async (tx) =>
        persistAssignmentState(observe(tx, calls), worldId, {
          before: stale,
          beforeFinish: empty,
          final: empty,
          closedOffers: [accepted()],
        }),
      ),
    ).rejects.toThrow('before');
    expect(calls).toEqual([]);
    expect(await db.assignmentOffer.findMany({ where: { worldId } })).toEqual(committed);
  }));

it('G6 직책 두 표와 제안·로그를 함께 쓴 뒤 실패하면 모두 롤백한다', async () =>
  withDatabase('g6', async ({ db, sql }) => {
    await seedOffice(sql);
    await seedOffer(db);
    const beforeRows = await rows(sql);
    const failure = new Error('합성 저장 뒤 의도한 실패');
    await expect(
      action(db, async (tx) => {
        const office = await loadOfficeState(tx, worldId);
        const changed = structuredClone(office);
        changed.offices[1]![5]!.revision++;
        changed.officeTurns![1]![5]![0] = { commandKey: 'nation_train', args: { amount: 2 } };
        await persistOfficeState(tx, worldId, office, changed);
        const before = await loadAssignmentState(tx, worldId);
        await persistAssignmentState(tx, worldId, {
          before,
          beforeFinish: empty,
          final: empty,
          closedOffers: [accepted()],
        });
        await tx.generalLog.create({
          data: {
            worldId,
            generalId: 1,
            tick: 200,
            commandKey: 'offer.respond',
            kind: 'success',
            text: '합성 시험 기록',
          },
        });
        expect(await tx.nationOffice.findFirst({ where: { worldId } })).toMatchObject({ turnRevision: 8 });
        expect(await tx.nationOfficeTurn.count({ where: { worldId } })).toBe(12);
        expect(await tx.assignmentOffer.findFirst({ where: { worldId } })).toMatchObject({ status: 'ACCEPTED' });
        expect(await tx.generalLog.count({ where: { worldId } })).toBe(1);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await rows(sql)).toEqual(beforeRows);
  }));

it('G7 Nation 생성·직책 저장·삭제 순서를 FK로 확인한다', async () =>
  withDatabase('g7', async ({ db, sql, initial }) => {
    await seedOffice(sql);
    await seedOffer(db);
    const offices = await loadOfficeState(db, worldId),
      beforeRows = await rows(sql);
    const nextOffices = {
      offices: { 2: { 5: { revision: 1, tenure: 1 } } },
      officeTurns: { 2: { 5: Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })) } },
    };
    await expect(action(db, async (tx) => persistOfficeState(tx, worldId, offices, nextOffices))).rejects.toMatchObject(
      { code: 'P2003' },
    );
    expect(await rows(sql)).toEqual(beforeRows);
    await action(db, async (tx) => {
      await tx.nation.create({ data: { ...initial.nations[0]!, worldId, id: 2, capitalCityKey: null } });
      await tx.city.updateMany({ where: { worldId }, data: { nationId: 2 } });
      await tx.general.updateMany({ where: { worldId }, data: { nationId: 2 } });
      await persistOfficeState(tx, worldId, offices, nextOffices);
      const before = await loadAssignmentState(tx, worldId);
      await persistAssignmentState(tx, worldId, { before, beforeFinish: before, final: before, closedOffers: [] });
      // FK와 저장 순서만 검사한다. 국가 멸망 규칙이나 B1 처리는 실행하지 않는다.
      await tx.nation.delete({ where: { worldId_id: { worldId, id: 1 } } });
    });
    expect(await db.nation.findMany({ where: { worldId }, select: { id: true } })).toEqual([{ id: 2 }]);
    expect(await loadOfficeState(db, worldId)).toEqual(nextOffices);
    expect(await db.assignmentOffer.findMany({ where: { worldId } })).toEqual([
      {
        worldId,
        targetGeneralId: 7,
        ...original,
        status: 'PENDING',
        resolvedBy: null,
        cancelReason: null,
        resolvedTick: null,
      },
    ]);
  }));

it('G8 종료된 id와 새 제안의 기본키 충돌을 전파한다', async () =>
  withDatabase('g8', async ({ db }) => {
    await seedOffer(db);
    await action(db, async (tx) =>
      persistAssignmentState(tx, worldId, {
        before: snapshot(),
        beforeFinish: empty,
        final: empty,
        closedOffers: [accepted()],
      }),
    );
    const beforeRows = await db.assignmentOffer.findMany({ where: { worldId } });
    await expect(
      action(db, async (tx) => {
        await tx.world.update({ where: { id: worldId }, data: { actionSequence: 1 } });
        await persistAssignmentState(tx, worldId, {
          before: empty,
          beforeFinish: snapshot(),
          final: snapshot(),
          closedOffers: [],
        });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await db.assignmentOffer.findMany({ where: { worldId } })).toEqual(beforeRows);
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).actionSequence).toBe(0);
  }));

it('G9 원본 증인을 잃으면 실제 DB 쓰기가 0이다', async () =>
  withDatabase('g9', async ({ db, sql }) => {
    const beforeRows = await rows(sql),
      calls: string[] = [];
    await expect(
      action(db, async (tx) =>
        persistAssignmentState(observe(tx, calls), worldId, {
          before: empty,
          beforeFinish: empty,
          final: empty,
          closedOffers: [cancelled()],
        }),
      ),
    ).rejects.toThrow('종료 기록이 상태');
    expect(calls).toEqual([]);
    expect(await rows(sql)).toEqual(beforeRows);
  }));

it('G10 옛 상태에 빈 제안 키를 넣지 않아 hash가 같다', async () =>
  withDatabase('g10', async ({ db, initial }) => {
    const legacy = toWorldState(initial),
      before = hashState(legacy);
    expect(Object.hasOwn(legacy, 'assignmentOffers')).toBe(false);
    const loaded = await loadAssignmentState(db, worldId);
    expect(loaded).toEqual({});
    const after = { ...legacy, ...loaded };
    expect(Object.hasOwn(after, 'assignmentOffers')).toBe(false);
    expect(hashState(after)).toBe(before);
  }));
