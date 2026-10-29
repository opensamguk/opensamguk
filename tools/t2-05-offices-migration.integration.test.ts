import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { initialReplayState, runReplayAction } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive, type ReplayArchive } from '../apps/engine/src/replay';

type PgClient = {
  connect(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pgRequire = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
const { Client } = pgRequire('pg') as { Client: new (config: { connectionString: string }) => PgClient };
const migration = '20261023071000_nation_offices';
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

async function withDatabase(run: (client: PgClient, db: ReturnType<typeof createDb>) => Promise<void>) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)) throw new Error('전용 테스트 DB가 필요합니다.');
  const name = `t205_offices_${randomUUID().replaceAll('-', '')}_test`;
  const target = new URL(url),
    adminUrl = new URL(url);
  target.pathname = `/${name}`;
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.href });
  const client = new Client({ connectionString: target.href });
  const db = createDb(target.href);
  let created = false;
  let oid: string | undefined;
  const errors: unknown[] = [];
  await admin.connect();
  try {
    expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    oid = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows[0]?.oid as
      string | undefined;
    expect(oid).toMatch(/^\d+$/);
    await client.connect();
    await run(client, db);
  } catch (error) {
    errors.push(error);
  } finally {
    const closed = await Promise.allSettled([client.end(), db.$disconnect()]);
    for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
    try {
      if (created) {
        expect(
          closed.every((result) => result.status === 'fulfilled'),
          '자체 연결 종료',
        ).toBe(true);
        expect(oid).toMatch(/^\d+$/);
        const ownOid = async () =>
          (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows;
        expect(await ownOid()).toEqual([{ oid }]);
        let connections = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [
          name,
        ]);
        for (let attempt = 0; connections.rows[0]?.count !== 0 && attempt < 20; attempt++) {
          await delay(50);
          connections = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [
            name,
          ]);
        }
        expect(connections.rows).toEqual([{ count: 0 }]);
        expect(await ownOid()).toEqual([{ oid }]);
        await admin.query(`DROP DATABASE "${name}"`);
      }
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
  if (errors.length) throw new AggregateError(errors, '직책 migration 본문·연결·정리 검사 실패');
}

async function controlWorld(client: PgClient, id: string) {
  await insert(client, 'World', {
    id,
    name: id,
    scenarioKey: 'office-test',
    mapKey: 'office-test',
    unitSetKey: 'office-test',
    seed: 'office-test',
    startYear: 191,
    turnTermMinutes: 1,
    initialStateHash: 'fixture',
    statRules: {},
    unitSet: {},
  });
  for (const nationId of [1, 2]) {
    await insert(client, 'Nation', {
      worldId: id,
      id: nationId,
      name: `국가${nationId}`,
      color: '#000080',
      gold: 1,
      rice: 1,
      description: '',
      tech: 0,
      philosophy: '',
      level: 0,
    });
  }
  for (let slot = 0; slot < 30; slot++) {
    await insert(client, 'NationTurn', { worldId: id, nationId: 1, slot, commandKey: 'nation_rest', args: {} });
  }
}

async function legacyWorld(client: PgClient) {
  const archive = JSON.parse(
    await readFile(new URL('../apps/engine/test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
  ) as ReplayArchive;
  expect(archive.inputs).toEqual([]);
  expect(archive.origin.version).toBe(1);
  expect(archive.months.at(-1)?.stateHash).toBe(GOLDEN);
  expect(replayArchive(archive, 12).at(-1)?.stateHash).toBe(GOLDEN);
  let replay = initialReplayState(archive.origin.initial);
  const last = archive.months.at(-1)!;
  for (let sequence = 1; sequence <= last.sequence; sequence++) {
    replay = runReplayAction(replay, archive.origin.initial.seed, archive.origin.initial.unitSet);
  }
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
  for (const nation of Object.values(replay.state.nations)) {
    await insert(client, 'Nation', { ...nation, worldId, capitalCityKey: null });
  }
  for (const city of Object.values(replay.state.cities)) await insert(client, 'City', { ...city, worldId });
  for (const nation of Object.values(replay.state.nations)) {
    await client.query('UPDATE "Nation" SET "capitalCityKey"=$1 WHERE "worldId"=$2 AND id=$3', [
      nation.capitalCityKey,
      worldId,
      nation.id,
    ]);
  }
  for (const general of Object.values(replay.state.generals)) {
    expect(general.userId).toBeNull();
    await insert(client, 'General', { ...general, worldId, turnRevision: replay.revisions[general.id] ?? 0 });
  }
  for (const [id, turns] of Object.entries(replay.turns)) {
    for (const [slot, turn] of turns.entries()) {
      await insert(client, 'GeneralTurn', { ...turn, worldId, generalId: Number(id), slot, explicit: true });
    }
  }
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
  return worldId;
}

async function existingRows(client: PgClient) {
  const rows: Record<string, unknown> = {};
  for (const table of [
    'World',
    'Nation',
    'City',
    'General',
    'GeneralTurn',
    'NationTurn',
    'InputEvent',
    'YearbookSnapshot',
  ]) {
    const data =
      table === 'World'
        ? "to_jsonb(t) - 'treatyFormat' - 'personnelFormat' - 'replayFormat' - 'ruleFeatures' - 'operationalMap' - 'campaignState' - 'cityResourcesState'"
        : table === 'City'
          ? "to_jsonb(t) - 'kind'"
          : table === 'General'
            ? "to_jsonb(t) - 'residenceTick' - 'politics' - 'charm'"
            : "to_jsonb(t) - 'treatyFormat'";
    rows[table] = (await client.query(`SELECT ${data} AS data FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows;
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

async function verifyConstraints(client: PgClient) {
  const office = { worldId: 'control', nationId: 1, officerLevel: 5 };
  const turn = { ...office, slot: 0 };
  await insert(client, 'NationOffice', office);
  await insert(client, 'NationOfficeTurn', turn);
  expect((await client.query('SELECT "turnRevision", tenure FROM "NationOffice"')).rows).toEqual([
    { turnRevision: 0, tenure: 0 },
  ]);
  expect(
    (await client.query('SELECT "commandKey", args, pg_typeof(args)::text AS type FROM "NationOfficeTurn"')).rows,
  ).toEqual([{ commandKey: 'nation_rest', args: {}, type: 'jsonb' }]);
  for (const level of [6, 7, 8, 9, 10, 11, 12]) {
    // NationOffice 행 없이도 칸이 저장된다. 두 표 사이 FK가 없어야 한다.
    await insert(client, 'NationOfficeTurn', {
      ...turn,
      officerLevel: level,
      slot: 11,
      args: { nested: [level, null] },
    });
  }
  expect((await client.query('SELECT count(*)::int AS count FROM "NationOffice"')).rows).toEqual([{ count: 1 }]);
  for (const level of [6, 7, 8, 9, 10, 11, 12])
    await insert(client, 'NationOffice', { ...office, officerLevel: level });

  await expect(insert(client, 'NationOffice', office)).rejects.toMatchObject({
    code: '23505',
    constraint: 'NationOffice_pkey',
  });
  await expect(insert(client, 'NationOfficeTurn', turn)).rejects.toMatchObject({
    code: '23505',
    constraint: 'NationOfficeTurn_pkey',
  });
  for (const level of [4, 13]) {
    await expect(insert(client, 'NationOffice', { ...office, officerLevel: level })).rejects.toMatchObject({
      code: '23514',
      constraint: 'NationOffice_officerLevel_check',
    });
    await expect(insert(client, 'NationOfficeTurn', { ...turn, officerLevel: level })).rejects.toMatchObject({
      code: '23514',
      constraint: 'NationOfficeTurn_officerLevel_check',
    });
  }
  for (const slot of [-1, 12]) {
    await expect(insert(client, 'NationOfficeTurn', { ...turn, slot })).rejects.toMatchObject({
      code: '23514',
      constraint: 'NationOfficeTurn_slot_check',
    });
  }
  for (const field of ['turnRevision', 'tenure']) {
    await expect(insert(client, 'NationOffice', { ...office, nationId: 2, [field]: -1 })).rejects.toMatchObject({
      code: '23514',
      constraint: `NationOffice_${field}_check`,
    });
    await expect(insert(client, 'NationOffice', { ...office, nationId: 2, [field]: null })).rejects.toMatchObject({
      code: '23502',
      column: field,
    });
  }
  await expect(insert(client, 'NationOfficeTurn', { ...turn, slot: 1, args: null })).rejects.toMatchObject({
    code: '23502',
    column: 'args',
  });
  for (const table of ['NationOffice', 'NationOfficeTurn']) {
    await expect(
      insert(client, table, { ...(table === 'NationOffice' ? office : turn), nationId: 999 }),
    ).rejects.toMatchObject({ code: '23503', constraint: `${table}_worldId_nationId_fkey` });
    await insert(client, table, { ...(table === 'NationOffice' ? office : turn), nationId: 2 });
    await insert(client, table, { ...(table === 'NationOffice' ? office : turn), worldId: 'other' });
  }
  await client.query('DELETE FROM "Nation" WHERE "worldId"=$1 AND id=$2', ['control', 1]);
  for (const table of ['NationOffice', 'NationOfficeTurn']) {
    expect(
      (await client.query(`SELECT "worldId", "nationId" FROM "${table}" ORDER BY "worldId", "nationId"`)).rows,
    ).toEqual([
      { worldId: 'control', nationId: 2 },
      { worldId: 'other', nationId: 1 },
    ]);
  }
}

it.each(['empty', 'legacy'] as const)(
  'T2-05 %s DB에 직책 두 표를 더해도 기존 행·origin 1 바이트·골든을 보존한다',
  async (mode) => {
    await withDatabase(async (client, db) => {
      const directories = (await readdir(migrations)).filter((name) => /^\d/.test(name)).sort();
      const previous = directories.filter((name) => name < migration);
      const later = directories.filter((name) => name > migration);
      expect(later).toEqual([
        '20261023072000_world_ext_slices',
        '20261023073000_treaties',
        '20261023074000_assignment_storage',
        '20261024000000_replay_features',
        '20261024000000_world_personnel_format',
        '20261025000000_input_event_step_tick',
        '20261026000000_game_resource',
        '20261027000000_treaty_break_trust',
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
        '20261108000000_city_resources_state',
      ]);
      for (const directory of previous) {
        await client.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'));
      }
      if (mode === 'legacy') {
        await legacyWorld(client);
        await controlWorld(client, 'control');
      }
      const before = await existingRows(client);
      const beforeExport = mode === 'legacy' ? await rawArchive(client, 'legacy') : undefined;
      if (mode === 'legacy') {
        expect((before.NationTurn as unknown[]).length).toBe(30);
      }
      await client.query(await readFile(new URL(`${migration}/migration.sql`, migrations), 'utf8'));
      expect(await existingRows(client)).toEqual(before);
      for (const table of ['NationOffice', 'NationOfficeTurn']) {
        expect((await client.query(`SELECT count(*)::int AS count FROM "${table}"`)).rows).toEqual([{ count: 0 }]);
      }
      if (mode === 'legacy') expect(await rawArchive(client, 'legacy')).toBe(beforeExport);
      else await controlWorld(client, 'control');
      await controlWorld(client, 'other');
      await verifyConstraints(client);
      const settled = await existingRows(client);
      const readOffices = async () => {
        const rows: Record<string, unknown> = {};
        for (const table of ['NationOffice', 'NationOfficeTurn'])
          rows[table] = (
            await client.query(`SELECT to_jsonb(t) AS data FROM "${table}" t ORDER BY to_jsonb(t)::text`)
          ).rows;
        return rows;
      };
      const offices = await readOffices();
      // 후보 검증을 마친 뒤 후행 SQL을 적용해야 최신 앱의 스키마와 맞는다.
      for (const directory of later)
        await client.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'));
      expect((await client.query('SELECT id FROM "World" WHERE "operationalMap" IS NOT NULL')).rows).toEqual([]);
      expect((await client.query('SELECT id FROM "World" WHERE "campaignState" IS NOT NULL')).rows).toEqual([]);
      expect((await client.query('SELECT id FROM "World" WHERE "cityResourcesState" IS NOT NULL')).rows).toEqual([]);
      expect((await client.query('SELECT "cityKey" FROM "City" WHERE "kind" IS NOT NULL')).rows).toEqual([]);
      expect(
        (await client.query('SELECT id FROM "General" WHERE "politics" IS NOT NULL OR "charm" IS NOT NULL')).rows,
      ).toEqual([]);
      expect(await existingRows(client)).toEqual(settled);
      expect(await readOffices()).toEqual(offices);
      expect(
        (await client.query('SELECT count(*)::int AS count FROM "World" WHERE "treatyFormat" IS NOT NULL')).rows,
      ).toEqual([{ count: 0 }]);
      expect((await client.query('SELECT DISTINCT "personnelFormat" FROM "World"')).rows).toEqual([
        { personnelFormat: null },
      ]);
      expect((await client.query('SELECT DISTINCT "replayFormat", "ruleFeatures" FROM "World"')).rows).toEqual([
        { replayFormat: 1, ruleFeatures: [] },
      ]);
      for (const table of ['Treaty', 'WorldExtSlice', 'AssignmentOffer'])
        expect((await client.query(`SELECT count(*)::int AS count FROM "${table}"`)).rows).toEqual([{ count: 0 }]);
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
