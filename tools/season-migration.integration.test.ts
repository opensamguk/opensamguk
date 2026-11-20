import { ciGreenDatabaseName } from './test-database';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import type { ReplayArchive } from '../apps/engine/src/replay';

it('T1-26 이전 실제 DB 행을 migration해도 초기·월간 해시·origin·장수 배치를 바꾸지 않는다', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
  const target = new URL(url),
    adminUrl = new URL(url);
  const name = ciGreenDatabaseName(`opensamguk_ci_green_${randomUUID().replaceAll('-', '').slice(0, 20)}_test`);
  target.pathname = `/${name}`;
  adminUrl.pathname = '/postgres';
  const admin = createDb(adminUrl.href),
    legacy = createDb(target.href);
  const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const require = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
  const { Client } = require('pg') as {
    Client: new (options: { connectionString: string }) => {
      connect(): Promise<void>;
      query(sql: string): Promise<unknown>;
      end(): Promise<void>;
    };
  };
  const migrationClient = new Client({ connectionString: target.href });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  try {
    await migrationClient.connect();
    const root = new URL('../packages/db/prisma/migrations/', import.meta.url);
    const migration = '20261023000000_world_outcome';
    const apply = async (directory: string) => {
      const text = await readFile(new URL(`${directory}/migration.sql`, root), 'utf8');
      await migrationClient.query(text);
    };
    for (const directory of (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name < migration)
      .map((entry) => entry.name)
      .sort())
      await apply(directory);
    const archive = JSON.parse(
      await readFile(new URL('fixtures/migration-replay-v1.json', import.meta.url), 'utf8'),
    ) as ReplayArchive;
    // Historical JSON is opaque to this schema migration; current replay validation is tested separately.
    const last = archive.months.at(-1)!;
    const initialState = archive.origin.initial;
    const replay = {
      state: {
        nations: initialState.nations,
        cities: initialState.cities,
        generals: initialState.generals,
        diplomacies: initialState.diplomacies,
      },
      turns: Object.fromEntries(
        initialState.generals.map((general) => [
          general.id,
          Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {} })),
        ]),
      ),
    };
    const initial = archive.origin.initial,
      worldId = randomUUID();
    await legacy.$executeRawUnsafe(
      `INSERT INTO "World" (id,name,"scenarioKey","mapKey","unitSetKey",seed,"startYear","turnTermMinutes",status,"clockTick","clockAnchorAt","initialStateHash","statRules","unitSet","monthlyTick","actionSequence","replayOrigin") VALUES ($1,'legacy',$2,$3,$4,$5,$6,60,'RUNNING',$7,NOW(),$8,$9::jsonb,$10::jsonb,$7,$11,$12::jsonb)`,
      worldId,
      initial.scenarioKey,
      initial.mapKey,
      initial.unitSetKey,
      initial.seed,
      initial.startYear,
      last.tick,
      archive.origin.initialStateHash,
      JSON.stringify(initial.statRules),
      JSON.stringify(initial.unitSet),
      last.sequence,
      JSON.stringify(archive.origin),
    );
    const insert = async (table: string, rows: unknown[]) => {
      if (rows.length)
        await legacy.$executeRawUnsafe(
          `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(NULL::"${table}", $1::json)`,
          JSON.stringify(rows),
        );
    };
    await insert(
      'Nation',
      Object.values(replay.state.nations).map((nation) => ({ ...nation, worldId, capitalCityKey: null })),
    );
    await insert(
      'City',
      Object.values(replay.state.cities).map((city) => ({ ...city, worldId })),
    );
    for (const nation of Object.values(replay.state.nations))
      await legacy.$executeRawUnsafe(
        'UPDATE "Nation" SET "capitalCityKey" = $1 WHERE "worldId" = $2 AND id = $3',
        nation.capitalCityKey,
        worldId,
        nation.id,
      );
    await insert(
      'General',
      Object.values(replay.state.generals).map((general) => ({
        ...general,
        worldId,
        turnRevision: 0,
        battleWins: 0,
        captures: 0,
      })),
    );
    await insert(
      'GeneralTurn',
      Object.entries(replay.turns).flatMap(([generalId, turns]) =>
        turns.map((turn, slot) => ({ ...turn, worldId, generalId: Number(generalId), slot })),
      ),
    );
    await insert(
      'Diplomacy',
      replay.state.diplomacies.map((diplomacy) => ({ ...diplomacy, worldId })),
    );
    await insert(
      'YearbookSnapshot',
      archive.months.map((month) => ({ ...month, worldId })),
    );
    const before = await legacy.$queryRawUnsafe(
      'SELECT "initialStateHash", "replayOrigin", "actionSequence" FROM "World" WHERE id = $1',
      worldId,
    );
    const ticks = await legacy.$queryRawUnsafe(
      'SELECT id,"nextTurnTick" FROM "General" WHERE "worldId" = $1 ORDER BY id',
      worldId,
    );
    const storedRows = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of ['Nation', 'City', 'General', 'GeneralTurn', 'Diplomacy', 'YearbookSnapshot'])
        rows[table] = await legacy.$queryRawUnsafe(
          `SELECT to_jsonb(t) AS data FROM "${table}" t WHERE "worldId"=$1 ORDER BY to_jsonb(t)::text`,
          worldId,
        );
      return rows;
    };
    const beforeRows = await storedRows();
    await apply(migration);
    expect(await storedRows()).toEqual(beforeRows);
    const world = await legacy.world.findUniqueOrThrow({
      where: { id: worldId },
      select: { endYear: true, clockMode: true, outcomeFromSequence: true },
    });
    expect(world.endYear).toBeNull();
    expect(world.clockMode).toBe('REALTIME');
    expect(world.outcomeFromSequence).toBe(last.sequence);
    expect(
      await legacy.$queryRawUnsafe(
        'SELECT "initialStateHash", "replayOrigin", "actionSequence" FROM "World" WHERE id = $1',
        worldId,
      ),
    ).toEqual(before);
    expect(
      await legacy.$queryRawUnsafe('SELECT id,"nextTurnTick" FROM "General" WHERE "worldId" = $1 ORDER BY id', worldId),
    ).toEqual(ticks);
    expect(
      await legacy.$queryRawUnsafe(
        'SELECT "tick","sequence","data","stateHash" FROM "YearbookSnapshot" WHERE "worldId"=$1 ORDER BY "tick"',
        worldId,
      ),
    ).toEqual(archive.months.map(({ tick, sequence, data, stateHash }) => ({ tick, sequence, data, stateHash })));
  } finally {
    await migrationClient.end();
    await legacy.$disconnect();
    expect(await admin.$queryRaw`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = ${name}`).toEqual([
      { count: 0 },
    ]);
    await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
    await admin.$disconnect();
  }
}, 60000);
