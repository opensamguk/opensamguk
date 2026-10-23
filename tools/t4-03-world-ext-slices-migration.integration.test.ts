import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createDb, readWorldExtRows, writeWorldExtChanges } from '../packages/db/src/index';
import { initialReplayState, runReplayAction } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive, type ReplayArchive } from '../apps/engine/src/replay';
import { testDatabaseUrl } from './test-database';

type PgClient = {
  connect(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
type Db = ReturnType<typeof createDb>;
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pgRequire = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
const { Client } = pgRequire('pg') as { Client: new (config: { connectionString: string }) => PgClient };
const migration = '20261023072000_world_ext_slices';
const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
const GOLDEN = 'd60ad5f09185a889fc64926efe4e367e1b909710b227e76e3005698e71d80a0b';

async function insert(client: PgClient, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  if (![table, ...keys].every((key) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)))
    throw new Error('잘못된 시험 식별자입니다.');
  await client.query(
    `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')})`,
    Object.values(row),
  );
}

async function withDatabase(mode: string, run: (client: PgClient, db: Db) => Promise<void>) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('전용 테스트 DB가 필요합니다.');
  // run-integration이 두 URL을 시험 DB로 맞춘 뒤이므로 시험 DB 이름만 다시 검사한다.
  const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  const name = `t403_ext_${randomUUID().replaceAll('-', '')}_${mode}_test`;
  if (!/^t403_ext_[a-f0-9]{32}_(empty|legacy)_test$/.test(name)) throw new Error('시험 DB 이름이 올바르지 않습니다.');
  const target = new URL(source),
    adminUrl = new URL(source);
  target.pathname = `/${name}`;
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.href });
  const client = new Client({ connectionString: target.href });
  const db = createDb(target.href);
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await client.connect();
    await run(client, db);
  } finally {
    try {
      await Promise.all([client.end(), db.$disconnect()]);
      if (created) {
        expect(
          (await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows,
        ).toEqual([{ count: 0 }]);
        // 위에서 생성한 UUID DB만 지운다. 다른 연결을 종료하거나 DROP FORCE를 쓰지 않는다.
        await admin.query(`DROP DATABASE "${name}"`);
        expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
      }
    } finally {
      await admin.end();
    }
  }
}

async function seedWorld(client: PgClient, id: string) {
  await insert(client, 'World', {
    id,
    name: id,
    scenarioKey: 'ext-storage-test',
    mapKey: 'ext-storage-test',
    unitSetKey: 'ext-storage-test',
    seed: 'ext-storage-test',
    startYear: 191,
    turnTermMinutes: 1,
    initialStateHash: 'fixture',
    statRules: {},
    unitSet: {},
  });
}

async function seedLegacy(client: PgClient) {
  const archive = JSON.parse(
    await readFile(new URL('../apps/engine/test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
  ) as ReplayArchive;
  expect(archive.inputs).toEqual([]);
  expect(archive.origin.version).toBe(1);
  expect(replayArchive(archive, 12).at(-1)?.stateHash).toBe(GOLDEN);
  let replay = initialReplayState(archive.origin.initial);
  const last = archive.months.at(-1)!;
  for (let sequence = 1; sequence <= last.sequence; sequence++)
    replay = runReplayAction(replay, archive.origin.initial.seed, archive.origin.initial.unitSet);
  expect(hashState(replay)).toBe(GOLDEN);
  const worldId = 'legacy';
  const initial = archive.origin.initial;
  await insert(client, 'World', {
    id: worldId,
    name: '기존 월드',
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    seed: initial.seed,
    startYear: initial.startYear,
    turnTermMinutes: 60,
    status: 'PAUSED',
    clockTick: last.tick,
    monthlyTick: last.tick,
    actionSequence: last.sequence,
    outcomeFromSequence: last.sequence,
    initialStateHash: archive.origin.initialStateHash,
    statRules: initial.statRules,
    unitSet: initial.unitSet,
    replayOrigin: archive.origin,
    commandMeta: replay.state.commandMeta ?? null,
  });
  for (const nation of Object.values(replay.state.nations))
    await insert(client, 'Nation', { ...nation, worldId, capitalCityKey: null });
  for (const city of Object.values(replay.state.cities)) await insert(client, 'City', { ...city, worldId });
  for (const nation of Object.values(replay.state.nations))
    await client.query('UPDATE "Nation" SET "capitalCityKey"=$1 WHERE "worldId"=$2 AND id=$3', [
      nation.capitalCityKey,
      worldId,
      nation.id,
    ]);
  for (const general of Object.values(replay.state.generals)) {
    expect(general.userId).toBeNull();
    await insert(client, 'General', { ...general, worldId, turnRevision: replay.revisions[general.id] ?? 0 });
  }
  for (const [id, turns] of Object.entries(replay.turns))
    for (const [slot, turn] of turns.entries())
      await insert(client, 'GeneralTurn', { ...turn, worldId, generalId: Number(id), slot, explicit: true });
  for (const diplomacy of replay.state.diplomacies) await insert(client, 'Diplomacy', { ...diplomacy, worldId });
  for (const month of archive.months) await insert(client, 'YearbookSnapshot', { ...month, worldId });
  expect(JSON.parse(await rawArchive(client, worldId))).toEqual({
    version: 2,
    origin: archive.origin,
    config: { endYear: null, outcomeFromSequence: last.sequence },
    inputs: [],
    months: archive.months,
    end: null,
    afterEnd: [],
  });
  await seedWorld(client, 'preserved');
  await insert(client, 'Nation', {
    worldId: 'preserved',
    id: 1,
    name: '저장 시험',
    color: '#000080',
    gold: 1,
    rice: 1,
    description: '',
    tech: 0,
    philosophy: '',
    level: 0,
  });
  await insert(client, 'NationOffice', { worldId: 'preserved', nationId: 1, officerLevel: 5 });
  await insert(client, 'NationOfficeTurn', { worldId: 'preserved', nationId: 1, officerLevel: 5, slot: 0 });
}

async function existingRows(client: PgClient) {
  const tables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT IN ('WorldExtSlice', 'Treaty') ORDER BY table_name",
  );
  const rows: Record<string, unknown> = {};
  for (const { table_name: table } of tables.rows) {
    if (typeof table !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table))
      throw new Error('잘못된 시험 표 이름입니다.');
    rows[table] = (
      await client.query(`SELECT to_jsonb(t) - 'treatyFormat' AS data FROM "${table}" t ORDER BY to_jsonb(t)::text`)
    ).rows;
  }
  return rows;
}

// 후보 전 스키마에서 현재 export의 F null·종료 없음·입력 없음 갈래를 raw 행으로 읽는다.
async function rawArchive(client: PgClient, worldId: string) {
  const worlds = (
    await client.query(
      'SELECT "replayOrigin", "endYear", "outcomeFromSequence", "policyFromSequence" FROM "World" WHERE id=$1',
      [worldId],
    )
  ).rows;
  expect(worlds).toHaveLength(1);
  const world = worlds[0]!;
  expect(world.replayOrigin).not.toBeNull();
  expect(world.policyFromSequence).toBeNull();
  for (const table of ['WorldResult', 'InputEvent'])
    expect(
      (await client.query(`SELECT count(*)::int AS count FROM "${table}" WHERE "worldId"=$1`, [worldId])).rows,
    ).toEqual([{ count: 0 }]);
  const months = (
    await client.query(
      'SELECT tick, year, month, sequence, "stateHash", data FROM "YearbookSnapshot" WHERE "worldId"=$1 ORDER BY tick',
      [worldId],
    )
  ).rows;
  return JSON.stringify({
    version: 2,
    origin: world.replayOrigin,
    config: { endYear: world.endYear, outcomeFromSequence: world.outcomeFromSequence },
    inputs: [],
    months: months.map(({ tick, year, month, sequence, stateHash, data }) => ({
      tick,
      year,
      month,
      sequence,
      stateHash,
      data,
    })),
    end: null,
    afterEnd: [],
  });
}

async function verifySchema(client: PgClient) {
  expect(
    (
      await client.query(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='WorldExtSlice' ORDER BY ordinal_position",
      )
    ).rows,
  ).toEqual([
    { column_name: 'worldId', data_type: 'text', is_nullable: 'NO', column_default: null },
    { column_name: 'key', data_type: 'text', is_nullable: 'NO', column_default: null },
    { column_name: 'value', data_type: 'jsonb', is_nullable: 'NO', column_default: null },
  ]);
  expect(
    (
      await client.query(
        "SELECT column_name FROM information_schema.key_column_usage WHERE table_schema='public' AND table_name='WorldExtSlice' AND constraint_name='WorldExtSlice_pkey' ORDER BY ordinal_position",
      )
    ).rows,
  ).toEqual([{ column_name: 'worldId' }, { column_name: 'key' }]);
  expect(
    (
      await client.query(
        "SELECT contype FROM pg_constraint WHERE conrelid='\"WorldExtSlice\"'::regclass AND contype IN ('p','f','c','u','x') ORDER BY contype",
      )
    ).rows,
  ).toEqual([{ contype: 'f' }, { contype: 'p' }]);
  expect(
    (
      await client.query(
        "SELECT confrelid::regclass::text AS target, confdeltype, confupdtype FROM pg_constraint WHERE conrelid='\"WorldExtSlice\"'::regclass AND contype='f'",
      )
    ).rows,
  ).toEqual([{ target: '"World"', confdeltype: 'c', confupdtype: 'c' }]);
}

async function seedSlices(client: PgClient, worldId: string, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values))
    await client.query('INSERT INTO "WorldExtSlice" ("worldId", "key", "value") VALUES ($1,$2,$3::jsonb)', [
      worldId,
      key,
      JSON.stringify(value),
    ]);
}

async function revisions(client: PgClient, worldId: string) {
  return (
    await client.query('SELECT "key", xmin::text AS revision FROM "WorldExtSlice" WHERE "worldId"=$1 ORDER BY "key"', [
      worldId,
    ])
  ).rows;
}

async function verifyStorage(client: PgClient, db: Db) {
  for (const id of ['slices', 'other', 'off', 'missing', 'invalid-read', 'json-null']) await seedWorld(client, id);
  const before = { same: { a: 1, b: [2] }, changed: null, text: '한글\ud83d\ude00', zero: 0, false: false, empty: '' };
  await seedSlices(client, 'slices', before);
  await seedSlices(client, 'other', before);
  const old = await revisions(client, 'slices');
  const other = await revisions(client, 'other');
  const restored = await db.$transaction((tx) => readWorldExtRows(tx, 'slices'));
  expect(restored).toEqual(before);
  expect(Object.getPrototypeOf(restored)).toBeNull();
  expect(
    (
      await client.query(
        'SELECT "value" IS NULL AS sql_null, jsonb_typeof("value") AS kind FROM "WorldExtSlice" WHERE "worldId"=$1 AND "key"=$2',
        ['slices', 'changed'],
      )
    ).rows,
  ).toEqual([{ sql_null: false, kind: 'null' }]);
  const next = { ...before, same: { b: [2], a: 1 }, changed: [true, false, {}, []] };
  await db.$transaction((tx) => writeWorldExtChanges(tx, 'slices', before, next));
  expect(await db.$transaction((tx) => readWorldExtRows(tx, 'slices'))).toEqual(next);
  const changed = await revisions(client, 'slices');
  for (const row of changed) {
    const previous = old.find((item) => item.key === row.key)!.revision;
    if (row.key === 'changed') expect(row.revision).not.toBe(previous);
    else expect(row.revision).toBe(previous);
  }
  await db.$transaction((tx) => writeWorldExtChanges(tx, 'slices', next, next));
  expect(await revisions(client, 'slices')).toEqual(changed);
  await db.$transaction((tx) => writeWorldExtChanges(tx, 'off', undefined, undefined));
  expect(await db.$transaction((tx) => readWorldExtRows(tx, 'off'))).toBeUndefined();
  await seedSlices(client, 'json-null', { value: 1 });
  await db.$transaction((tx) => writeWorldExtChanges(tx, 'json-null', { value: 1 }, { value: null }));
  expect(await db.$transaction((tx) => readWorldExtRows(tx, 'json-null'))).toEqual({ value: null });
  expect(
    (
      await client.query(
        'SELECT "value" IS NULL AS sql_null, jsonb_typeof("value") AS kind FROM "WorldExtSlice" WHERE "worldId"=$1',
        ['json-null'],
      )
    ).rows,
  ).toEqual([{ sql_null: false, kind: 'null' }]);

  const key = randomUUID();
  await expect(
    db.$transaction(async (tx) => {
      await writeWorldExtChanges(tx, 'slices', next, { ...next, changed: [99] });
      await tx.inputEvent.create({
        data: { worldId: 'slices', userId: 'fixture', kind: 'general.active', idempotencyKey: key, payload: {} },
      });
      throw new Error('commit boundary');
    }),
  ).rejects.toThrow('commit boundary');
  expect(await revisions(client, 'slices')).toEqual(changed);
  expect(await db.inputEvent.count({ where: { worldId: 'slices', idempotencyKey: key } })).toBe(0);

  for (const invalid of [
    undefined,
    {},
    { same: 1 },
    { ...next, extra: 1 },
    ...['\u0000', '\ud800', '\udfff', -0, { nested: [-0] }, { constructor: 1 }].map((value) => ({
      ...next,
      changed: value,
    })),
  ]) {
    await expect(db.$transaction((tx) => writeWorldExtChanges(tx, 'slices', next, invalid))).rejects.toThrow();
    expect(await revisions(client, 'slices')).toEqual(changed);
  }
  await expect(
    db.$transaction((tx) => writeWorldExtChanges(tx, 'slices', { ...next, text: '\u0000' }, next)),
  ).rejects.toThrow();
  expect(await revisions(client, 'slices')).toEqual(changed);
  await seedSlices(client, 'missing', { a: 1 });
  const missing = await revisions(client, 'missing');
  await expect(
    db.$transaction((tx) => writeWorldExtChanges(tx, 'missing', { a: 1, b: 2 }, { a: 3, b: 4 })),
  ).rejects.toThrow('저장된 확장 상태의 조각을 확인하세요.');
  expect(await revisions(client, 'missing')).toEqual(missing);
  expect(await db.$transaction((tx) => readWorldExtRows(tx, 'missing'))).toEqual({ a: 1 });

  for (const [world, sliceKey, value] of [
    ['slices', 'same', '{}'],
    ['absent', 'a', '{}'],
    [null, 'a', '{}'],
    ['slices', null, '{}'],
    ['slices', 'sql-null', null],
  ] as const) {
    const code =
      world === 'absent' ? '23503' : world === null || sliceKey === null || value === null ? '23502' : '23505';
    await expect(
      client.query('INSERT INTO "WorldExtSlice" ("worldId", "key", "value") VALUES ($1,$2,$3::jsonb)', [
        world,
        sliceKey,
        value,
      ]),
    ).rejects.toMatchObject({ code });
  }
  await expect(
    client.query('INSERT INTO "WorldExtSlice" ("worldId", "key") VALUES ($1,$2)', ['slices', 'no-default']),
  ).rejects.toMatchObject({ code: '23502' });
  // 저장 형식은 key 길이나 등록 여부를 제한하지 않는다. 예약 key 검사는 기존 helper가 맡는다.
  await seedSlices(client, 'off', { '': null, '미등록 / :': false, ['x'.repeat(1024)]: '' });
  expect(await db.$transaction((tx) => readWorldExtRows(tx, 'off'))).toEqual({
    '': null,
    '미등록 / :': false,
    ['x'.repeat(1024)]: '',
  });
  await seedSlices(client, 'invalid-read', JSON.parse('{"__proto__":1}'));
  await expect(db.$transaction((tx) => readWorldExtRows(tx, 'invalid-read'))).rejects.toThrow();
  await client.query('DELETE FROM "WorldExtSlice" WHERE "worldId"=$1', ['invalid-read']);
  await seedSlices(client, 'invalid-read', { nested: { constructor: 1 } });
  await expect(db.$transaction((tx) => readWorldExtRows(tx, 'invalid-read'))).rejects.toThrow();

  await client.query('DELETE FROM "World" WHERE id=$1', ['slices']);
  expect(
    (await client.query('SELECT count(*)::int AS count FROM "WorldExtSlice" WHERE "worldId"=$1', ['slices'])).rows,
  ).toEqual([{ count: 0 }]);
  expect(await revisions(client, 'other')).toEqual(other);
  expect(await db.$transaction((tx) => readWorldExtRows(tx, 'other'))).toEqual(before);
}

it.each(['empty', 'legacy'] as const)(
  'P-S %s DB에 실제 migration을 적용해 기존 행·해시·수출과 저장 제약을 확인한다',
  async (mode) => {
    await withDatabase(mode, async (client, db) => {
      const directories = (await readdir(migrations)).filter((name) => /^\d/.test(name)).sort();
      const previous = directories.filter((name) => name < migration);
      const later = directories.filter((name) => name > migration);
      expect(previous.at(-1)).toBe('20261023071000_nation_offices');
      expect(later).toEqual(['20261023073000_treaties']);
      for (const directory of previous)
        await client.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'));
      if (mode === 'legacy') await seedLegacy(client);
      const rows = await existingRows(client);
      const beforeExport = mode === 'legacy' ? await rawArchive(client, 'legacy') : undefined;
      await client.query(await readFile(new URL(`${migration}/migration.sql`, migrations), 'utf8'));
      expect(await existingRows(client)).toEqual(rows);
      expect((await client.query('SELECT count(*)::int AS count FROM "WorldExtSlice"')).rows).toEqual([{ count: 0 }]);
      if (mode === 'legacy') expect(await rawArchive(client, 'legacy')).toBe(beforeExport);
      await verifySchema(client);
      await verifyStorage(client, db);
      const settled = await existingRows(client);
      const readSlices = async () =>
        (
          await client.query(
            'SELECT "worldId", "key", "value"::text AS value FROM "WorldExtSlice" ORDER BY "worldId", "key"',
          )
        ).rows;
      const slices = await readSlices();
      // 후보 검증을 마친 뒤 후행 SQL을 적용해야 최신 앱의 스키마와 맞는다.
      for (const directory of later)
        await client.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'));
      expect(await existingRows(client)).toEqual(settled);
      expect(await readSlices()).toEqual(slices);
      expect(
        (await client.query('SELECT count(*)::int AS count FROM "World" WHERE "treatyFormat" IS NOT NULL')).rows,
      ).toEqual([{ count: 0 }]);
      expect((await client.query('SELECT count(*)::int AS count FROM "Treaty"')).rows).toEqual([{ count: 0 }]);
      if (mode === 'legacy') {
        const exported = await exportReplay(db, 'legacy');
        expect(exported.version).toBe(2);
        expect(JSON.stringify(exported)).toBe(beforeExport);
        expect(hashState(await db.$transaction((tx) => loadReplayState(tx, 'legacy')))).toBe(GOLDEN);
        expect(replayArchive(exported, 12).at(-1)?.stateHash).toBe(GOLDEN);
      }
    });
  },
  60_000,
);
