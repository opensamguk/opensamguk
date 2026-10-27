import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type Prisma } from '@opensamguk/db';
import type { OfficeTurns } from '@opensamguk/rules';
import { assertNoOfficeRows, assertPersonnelStorage, loadOfficeState, persistOfficeState } from './personnelState';

type PgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
type Catalog = { datname: string; oid: string }[];
type Snapshot = Awaited<ReturnType<typeof loadOfficeState>>;
type Queue = OfficeTurns[number][number];
const dbRequire = createRequire(new URL('../../../packages/db/package.json', import.meta.url));
const pgRequire = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
const { Client } = pgRequire('pg') as { Client: new (config: { connectionString: string }) => PgClient };
if (!process.env.TEST_DATABASE_URL) throw new Error('직책 저장 전용 테스트 DB가 필요합니다.');
const source = new URL(process.env.TEST_DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(source.protocol) || !/^[a-z][a-z0-9_]*_test$/.test(source.pathname.slice(1)))
  throw new Error('직책 저장 전용 테스트 DB 이름을 확인하세요.');
source.port ||= '5432';
if (
  !['127.0.0.1', 'localhost'].includes(source.hostname) ||
  !['5432', '5433'].includes(source.port) ||
  source.searchParams.has('host') ||
  source.searchParams.has('port')
)
  throw new Error('loopback 5432 또는 5433 시험 서버를 명시하세요.');
const name = `t205_office_codec_${randomUUID().replaceAll('-', '')}_test`;
if (!/^t205_office_codec_[a-f0-9]{32}_test$/.test(name)) throw new Error('자체 시험 DB 이름을 확인하세요.');
const adminUrl = new URL(source),
  target = new URL(source);
adminUrl.pathname = '/postgres';
target.pathname = `/${name}`;
const admin = new Client({ connectionString: adminUrl.href });
const client = new Client({ connectionString: target.href });
const db = createDb(target.href);
let adminConnected = false;
let created = false;
let createdOid: string | null = null;
let before: Catalog = [];
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
];

async function catalog(): Promise<Catalog> {
  return (await admin.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows.map((row) => {
    if (typeof row.datname !== 'string' || typeof row.oid !== 'string') throw new Error('DB 목록을 확인하세요.');
    return { datname: row.datname, oid: row.oid };
  });
}

beforeAll(async () => {
  await admin.connect();
  adminConnected = true;
  before = await catalog();
  if (before.some((row) => row.datname === name)) throw new Error('자체 시험 DB가 이미 있습니다.');
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  createdOid = (await catalog()).find((row) => row.datname === name)?.oid ?? null;
  expect(createdOid).not.toBeNull();
  console.info('T2-05 직책 DB 생성', JSON.stringify({ name, createdOid }));
  await client.connect();
  const migrations = new URL('../../../packages/db/prisma/migrations/', import.meta.url);
  const directories = (await readdir(migrations)).filter((entry) => /^\d{14}_/.test(entry)).sort();
  expect(directories.filter((directory) => requiredMigrations.includes(directory))).toEqual(requiredMigrations);
  for (const directory of directories)
    await client.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'));
});

afterAll(async () => {
  try {
    const disconnected = await Promise.allSettled([client.end(), db.$disconnect()]);
    expect(
      disconnected.every((result) => result.status === 'fulfilled'),
      '자체 연결 종료',
    ).toBe(true);
    if (!adminConnected) return;
    if (created) {
      expect((await catalog()).find((row) => row.datname === name)).toEqual({ datname: name, oid: createdOid });
      const connections = (
        await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name])
      ).rows;
      expect(connections).toEqual([{ count: 0 }]);
      // 이 실행이 만든 같은 OID의 DB만 연결 0개일 때 정상 삭제한다.
      await admin.query(`DROP DATABASE "${name}"`);
      const after = await catalog();
      expect(after).toEqual(before);
      console.info(
        'T2-05 직책 DB 정리',
        JSON.stringify({ name, createdOid, created, connectionsBeforeDrop: 0, dropped: true, before, after }),
      );
    }
  } finally {
    await admin.end();
  }
});

function queue(): Queue {
  return Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} }));
}

function nation(worldId: string, id: number) {
  return {
    worldId,
    id,
    name: `직책 시험 국가 ${id}`,
    color: '#123456',
    gold: 100,
    rice: 100,
    description: '',
    tech: 1,
    philosophy: '',
    level: 1,
  };
}

async function fixture(label: string): Promise<string> {
  const worldId = `${label}-${randomUUID()}`;
  await db.world.create({
    data: {
      id: worldId,
      name: label,
      scenarioKey: 'office-test',
      mapKey: 'office-test',
      unitSetKey: 'office-test',
      seed: 'office-test',
      startYear: 191,
      turnTermMinutes: 1,
      initialStateHash: 'office-test',
      statRules: {},
      unitSet: {},
    },
  });
  await db.nation.createMany({ data: [nation(worldId, 1), nation(worldId, 2)] });
  return worldId;
}

// codec과 같은 트랜잭션에서 World 행을 잠근다. 실제 리스·중앙 실행 경로의 시험은 아니다.
async function locked<T>(worldId: string, run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "World" WHERE "id"=${worldId} FOR UPDATE`;
    expect(rows).toEqual([{ id: worldId }]);
    return run(tx);
  });
}

async function physical(worldId: string) {
  const offices = await db.$queryRaw<unknown[]>`
    SELECT "nationId","officerLevel","turnRevision","tenure",ctid::text AS "rowId",xmin::text AS "version"
    FROM "NationOffice" WHERE "worldId"=${worldId} ORDER BY "nationId","officerLevel"
  `;
  const turns = await db.$queryRaw<unknown[]>`
    SELECT "nationId","officerLevel","slot","commandKey","args",ctid::text AS "rowId",xmin::text AS "version"
    FROM "NationOfficeTurn" WHERE "worldId"=${worldId} ORDER BY "nationId","officerLevel","slot"
  `;
  return { offices, turns };
}

async function initial(worldId: string): Promise<Snapshot> {
  const value = {
    offices: {
      1: { 5: { revision: 1, tenure: 1 }, 12: { revision: 7, tenure: 3 } },
      2: { 5: { revision: 2, tenure: 1 } },
    },
    officeTurns: { 1: { 5: queue(), 12: queue() }, 2: { 5: queue() } },
  };
  await locked(worldId, (tx) => persistOfficeState(tx, worldId, { offices: {} }, value));
  return value;
}

it('OC-PG-01 빈 월드를 읽고 다른 월드의 직책 행을 섞지 않는다', async () => {
  const worldId = await fixture('office-empty');
  const other = await fixture('office-other');
  await initial(other);
  await locked(worldId, async (tx) => {
    expect(await loadOfficeState(tx, worldId)).toEqual({ offices: {} });
    await assertNoOfficeRows(tx, worldId);
  });
  expect(await db.nationOffice.count({ where: { worldId: other } })).toBe(3);
  expect(await db.nationOfficeTurn.count({ where: { worldId: other } })).toBe(36);
});

it('OC-PG-02 드문 칸을 12칸으로 채우고 저장 수치와 누락의 기본 의미를 보존한다', async () => {
  const worldId = await fixture('office-sparse');
  await db.nationOffice.createMany({
    data: [
      { worldId, nationId: 1, officerLevel: 12, turnRevision: 17, tenure: 8 },
      { worldId, nationId: 1, officerLevel: 5 },
    ],
  });
  await db.nationOfficeTurn.createMany({
    data: [
      { worldId, nationId: 1, officerLevel: 12, slot: 0, commandKey: 'nation_train', args: { amount: 2 } },
      { worldId, nationId: 1, officerLevel: 5, slot: 11 },
      { worldId, nationId: 2, officerLevel: 12, slot: 4 },
    ],
  });
  const loaded = await locked(worldId, (tx) => loadOfficeState(tx, worldId));
  expect(loaded.offices).toEqual({ 1: { 12: { revision: 17, tenure: 8 }, 5: { revision: 0, tenure: 0 } } });
  expect(loaded.offices[2]?.[12] ?? { revision: 0, tenure: 0 }).toEqual({ revision: 0, tenure: 0 });
  const turns = loaded.officeTurns!;
  for (const slots of [turns[1]![12]!, turns[1]![5]!, turns[2]![12]!]) expect(slots).toHaveLength(12);
  expect(turns[1]![12]![0]).toEqual({ commandKey: 'nation_train', args: { amount: 2 } });
  expect(turns[1]![12]![1]).toEqual({ commandKey: 'nation_rest', args: {} });
  expect(turns[1]![12]![1]!.args).not.toBe(turns[1]![12]![2]!.args);
  const officeOnly = await fixture('office-only');
  await db.nationOffice.create({
    data: { worldId: officeOnly, nationId: 1, officerLevel: 5, turnRevision: 4, tenure: 2 },
  });
  expect(await locked(officeOnly, (tx) => loadOfficeState(tx, officeOnly))).toEqual({
    offices: { 1: { 5: { revision: 4, tenure: 2 } } },
  });
});

it('OC-PG-03 최초 직책과 JSON null을 포함한 12칸을 실제 JSONB로 왕복한다', async () => {
  const worldId = await fixture('office-json');
  const turns = queue();
  turns[0] = { commandKey: 'nation_rest', args: null };
  turns[1] = { commandKey: 'nation_rest', args: { 한글: ['값', null, 3] } };
  turns[2] = { commandKey: 'nation_rest', args: false };
  turns[3] = { commandKey: 'nation_rest', args: 0 };
  turns[4] = { commandKey: 'nation_rest', args: '' };
  const next = { offices: { 1: { 12: { revision: 23, tenure: 9 } } }, officeTurns: { 1: { 12: turns } } };
  await locked(worldId, async (tx) => {
    await persistOfficeState(tx, worldId, { offices: {} }, next);
    expect(await loadOfficeState(tx, worldId)).toEqual(next);
  });
  expect(
    await db.nationOfficeTurn.findMany({ where: { worldId }, orderBy: { slot: 'asc' }, select: { slot: true } }),
  ).toEqual(Array.from({ length: 12 }, (_, slot) => ({ slot })));
  expect(
    await db.$queryRaw<unknown[]>`
    SELECT "args" IS NULL AS "sqlNull", "args"='null'::jsonb AS "jsonNull"
    FROM "NationOfficeTurn" WHERE "worldId"=${worldId} AND "nationId"=1 AND "officerLevel"=12 AND "slot"=0
  `,
  ).toEqual([{ sqlNull: false, jsonNull: true }]);
});

it('OC-PG-04 바뀐 직책만 교체하고 다른 직책·월드·기존 30칸을 보존한다', async () => {
  const worldId = await fixture('office-diff');
  const other = await fixture('office-diff-other');
  const beforeState = await initial(worldId);
  await initial(other);
  await db.nationTurn.createMany({
    data: Array.from({ length: 30 }, (_, slot) => ({
      worldId,
      nationId: 1,
      slot,
      commandKey: 'legacy_sentinel',
      args: { slot, keep: true },
    })),
  });
  const untouched = () => db.$queryRaw<unknown[]>`
    SELECT "worldId","nationId","officerLevel","slot","commandKey","args",ctid::text AS "rowId",xmin::text AS "version"
    FROM "NationOfficeTurn" WHERE NOT ("worldId"=${worldId} AND "nationId"=1 AND "officerLevel"=12)
    ORDER BY "worldId","nationId","officerLevel","slot"
  `;
  const untouchedOffices = () => db.$queryRaw<unknown[]>`
    SELECT "worldId","nationId","officerLevel","turnRevision","tenure",ctid::text AS "rowId",xmin::text AS "version"
    FROM "NationOffice" WHERE NOT ("worldId"=${worldId} AND "nationId"=1 AND "officerLevel"=12)
    ORDER BY "worldId","nationId","officerLevel"
  `;
  const legacy = () =>
    db.$queryRaw<
      unknown[]
    >`SELECT *,ctid::text AS "rowId",xmin::text AS "version" FROM "NationTurn" WHERE "worldId"=${worldId} ORDER BY "nationId","slot"`;
  const preserved = {
    turns: await untouched(),
    offices: await untouchedOffices(),
    legacy: await legacy(),
    other: await physical(other),
  };
  const next = structuredClone(beforeState);
  next.offices[1]![12] = { revision: 10, tenure: 4 };
  next.officeTurns![1]![12]![0] = { commandKey: 'nation_train', args: { amount: 2 } };
  await locked(worldId, (tx) => persistOfficeState(tx, worldId, beforeState, next));
  expect({
    turns: await untouched(),
    offices: await untouchedOffices(),
    legacy: await legacy(),
    other: await physical(other),
  }).toEqual(preserved);
  expect(await locked(worldId, (tx) => loadOfficeState(tx, worldId))).toEqual(next);
});

it('OC-PG-05 수치만 바꾸거나 JSON 키 순서만 다르면 예턴 행을 다시 쓰지 않는다', async () => {
  const worldId = await fixture('office-noop');
  const beforeState = await initial(worldId);
  beforeState.officeTurns![1]![12]![0] = { commandKey: 'nation_rest', args: { a: 1, b: 2 } };
  const original = await locked(worldId, (tx) => loadOfficeState(tx, worldId));
  await locked(worldId, (tx) => persistOfficeState(tx, worldId, original, beforeState));
  const beforeRows = await physical(worldId);
  const next = structuredClone(beforeState);
  next.offices[1]![12] = { revision: 18, tenure: 6 };
  await locked(worldId, (tx) => persistOfficeState(tx, worldId, beforeState, next));
  expect((await physical(worldId)).turns).toEqual(beforeRows.turns);
  const counterRows = await physical(worldId);
  const reordered = structuredClone(next);
  reordered.officeTurns![1]![12]![0] = { commandKey: 'nation_rest', args: { b: 2, a: 1 } };
  await locked(worldId, (tx) => persistOfficeState(tx, worldId, next, reordered));
  expect(await physical(worldId)).toEqual(counterRows);
  expect(await locked(worldId, (tx) => loadOfficeState(tx, worldId))).toEqual(next);
});

it('OC-PG-06 revision 또는 tenure CAS 실패가 앞 직책의 쓰기까지 되돌린다', async () => {
  const worldId = await fixture('office-cas');
  await initial(worldId);
  for (const field of ['revision', 'tenure'] as const) {
    const stale = await locked(worldId, (tx) => loadOfficeState(tx, worldId));
    const old = stale.offices[1]![5]!;
    await locked(worldId, (tx) =>
      tx.nationOffice.update({
        where: { worldId_nationId_officerLevel: { worldId, nationId: 1, officerLevel: 5 } },
        data: field === 'revision' ? { turnRevision: old.revision + 1 } : { tenure: old.tenure + 1 },
      }),
    );
    const preserved = await physical(worldId);
    const next = structuredClone(stale);
    next.offices[1]![5]!.revision++;
    next.offices[1]![12]!.revision++;
    next.officeTurns![1]![12]![0] = { commandKey: 'nation_train', args: { amount: 2 } };
    let earlierWriteObserved = false;
    await expect(
      locked(worldId, async (tx) => {
        try {
          await persistOfficeState(tx, worldId, stale, next);
        } catch (error) {
          // 문자열 순서상 1:12가 1:5보다 먼저다. 예외 뒤에도 같은 TX에서 앞 쓰기를 읽는다.
          const earlier = await tx.nationOffice.findUniqueOrThrow({
            where: { worldId_nationId_officerLevel: { worldId, nationId: 1, officerLevel: 12 } },
          });
          expect(earlier.turnRevision).toBe(next.offices[1]![12]!.revision);
          const slot = await tx.nationOfficeTurn.findUniqueOrThrow({
            where: { worldId_nationId_officerLevel_slot: { worldId, nationId: 1, officerLevel: 12, slot: 0 } },
          });
          expect(slot.commandKey).toBe('nation_train');
          earlierWriteObserved = true;
          throw error;
        }
      }),
    ).rejects.toThrow('바뀌었습니다');
    expect(earlierWriteObserved).toBe(true);
    expect(await physical(worldId)).toEqual(preserved);
  }
});

it('OC-PG-07 국가 생성·삭제 순서와 생성 충돌·호출자 rollback을 검증한다', async () => {
  const worldId = await fixture('office-order');
  const state: Snapshot = { offices: { 3: { 5: { revision: 4, tenure: 2 } } }, officeTurns: { 3: { 5: queue() } } };
  await locked(worldId, async (tx) => {
    await tx.nation.create({ data: nation(worldId, 3) });
    await persistOfficeState(tx, worldId, { offices: {} }, state);
  });
  const preserved = await physical(worldId);
  await expect(
    locked(worldId, async (tx) => {
      await tx.nation.delete({ where: { worldId_id: { worldId, id: 3 } } });
      await persistOfficeState(tx, worldId, state, { offices: {} });
    }),
  ).rejects.toThrow('바뀌었습니다');
  expect(await physical(worldId)).toEqual(preserved);
  expect(await db.nation.count({ where: { worldId, id: 3 } })).toBe(1);
  const changed = structuredClone(state);
  changed.offices[3]![5]!.revision++;
  changed.officeTurns![3]![5]![0] = { commandKey: 'nation_train', args: { amount: 3 } };
  await expect(
    locked(worldId, async (tx) => {
      await persistOfficeState(tx, worldId, state, changed);
      throw new Error('호출자 rollback 시험');
    }),
  ).rejects.toThrow('호출자 rollback 시험');
  expect(await physical(worldId)).toEqual(preserved);
  await expect(
    locked(worldId, (tx) =>
      persistOfficeState(
        tx,
        worldId,
        { offices: {} },
        {
          offices: { 1: { 5: { revision: 1, tenure: 1 } }, 3: { 5: { revision: 5, tenure: 2 } } },
          officeTurns: { 1: { 5: queue() }, 3: { 5: queue() } },
        },
      ),
    ),
  ).rejects.toMatchObject({ code: 'P2002' });
  expect(await physical(worldId)).toEqual(preserved);
  const sparse = structuredClone(state);
  (sparse.officeTurns![2] ??= {})[5] = queue();
  await locked(worldId, (tx) => persistOfficeState(tx, worldId, state, sparse));
  expect(await db.nationOffice.count({ where: { worldId, nationId: 2 } })).toBe(0);
  const after = { offices: {}, officeTurns: { 2: { 5: queue() } } };
  await locked(worldId, async (tx) => {
    await persistOfficeState(tx, worldId, sparse, after);
    await tx.nation.delete({ where: { worldId_id: { worldId, id: 3 } } });
    expect(await loadOfficeState(tx, worldId)).toEqual(after);
  });
  expect(await db.nationOfficeTurn.count({ where: { worldId, nationId: 3 } })).toBe(0);
  expect(await db.nationOfficeTurn.count({ where: { worldId, nationId: 2 } })).toBe(12);
});

it('OC-PG-08 뒤 직책 오류를 쓰기 전에 잡고 두 표의 꺼짐 검사를 한다', async () => {
  const worldId = await fixture('office-invalid');
  await locked(worldId, async (tx) => {
    await expect(
      persistOfficeState(
        tx,
        worldId,
        { offices: {} },
        {
          offices: { 1: { 5: { revision: 1, tenure: 1 } } },
          officeTurns: { 1: { 5: queue() }, 2: { 12: queue().slice(1) } },
        },
      ),
    ).rejects.toThrow('12칸이어야');
    // 예외를 같은 트랜잭션 안에서 잡아 rollback 전에도 앞 직책 쓰기가 없음을 확인한다.
    expect(await tx.nationOffice.count({ where: { worldId } })).toBe(0);
    expect(await tx.nationOfficeTurn.count({ where: { worldId } })).toBe(0);
  });
  await db.nationOffice.create({ data: { worldId, nationId: 1, officerLevel: 5 } });
  const officeRows = await physical(worldId);
  await expect(locked(worldId, (tx) => assertNoOfficeRows(tx, worldId))).rejects.toThrow('직책 저장 행');
  expect(await physical(worldId)).toEqual(officeRows);
  const turnOnly = await fixture('office-disabled-turn');
  await db.nationOfficeTurn.create({ data: { worldId: turnOnly, nationId: 1, officerLevel: 12, slot: 0 } });
  const turnRows = await physical(turnOnly);
  await expect(locked(turnOnly, (tx) => assertNoOfficeRows(tx, turnOnly))).rejects.toThrow('직책 저장 행');
  expect(await physical(turnOnly)).toEqual(turnRows);
});

it('AC-INT-01 꺼진 인사의 통합 조회는 세 표 각각과 닫힌 제안도 거부하고 타월드 행을 섞지 않는다', async () => {
  const empty = await fixture('personnel-disabled-empty');
  for (const kind of ['office', 'turn', 'pending', 'closed'] as const) {
    const worldId = await fixture(`personnel-disabled-${kind}`);
    if (kind === 'office') await db.nationOffice.create({ data: { worldId, nationId: 1, officerLevel: 5 } });
    else if (kind === 'turn')
      await db.nationOfficeTurn.create({ data: { worldId, nationId: 1, officerLevel: 5, slot: 0 } });
    else
      await db.assignmentOffer.create({
        data: {
          worldId,
          id: '0-1-2',
          nationId: 1,
          issuerGeneralId: 1,
          targetGeneralId: 2,
          cityKey: 1,
          status: kind === 'pending' ? 'PENDING' : 'REJECTED',
          createdTick: 0,
          expiresTick: 60000,
          ...(kind === 'closed' ? { resolvedBy: 'RESPONSE', resolvedTick: 1 } : {}),
        },
      });
    await expect(locked(worldId, (tx) => assertPersonnelStorage(tx, worldId, false))).rejects.toThrow('인사 저장 행');
    await expect(locked(empty, (tx) => assertPersonnelStorage(tx, empty, false))).resolves.toBeUndefined();
  }
});
