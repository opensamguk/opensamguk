import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { initialReplayState, runReplayAction } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { exportReplay, replayArchive, type ReplayArchive } from '../apps/engine/src/replay';
import { loadReplayState } from '../apps/engine/src/monthly';

it('T1-26 이전 실제 DB 행을 migration해도 초기·월간 해시·origin·장수 배치를 바꾸지 않는다', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
  const target = new URL(url),
    adminUrl = new URL(url);
  const name = `season_${randomUUID().replaceAll('-', '')}_test`;
  target.pathname = `/${name}`;
  adminUrl.pathname = '/postgres';
  const admin = createDb(adminUrl.href),
    legacy = createDb(target.href);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  try {
    const root = new URL('../packages/db/prisma/migrations/', import.meta.url);
    const migration = '20261023000000_world_outcome';
    const apply = async (directory: string) => {
      const text = await readFile(new URL(`${directory}/migration.sql`, root), 'utf8');
      for (const statement of text
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean))
        await legacy.$executeRawUnsafe(statement);
    };
    for (const directory of (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name < migration)
      .map((entry) => entry.name)
      .sort())
      await apply(directory);
    const archive = JSON.parse(
      await readFile(new URL('../apps/engine/test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
    ) as ReplayArchive;
    replayArchive(archive, 12);
    let replay = initialReplayState(archive.origin.initial);
    const last = archive.months.at(-1)!;
    for (let sequence = 1; sequence <= last.sequence; sequence++)
      replay = runReplayAction(replay, archive.origin.initial.seed, archive.origin.initial.unitSet);
    expect(hashState(replay)).toBe(last.stateHash);
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
        turnRevision: replay.revisions[general.id],
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
    await apply(migration);
    const world = await legacy.world.findUniqueOrThrow({ where: { id: worldId } });
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
    expect(hashState(await legacy.$transaction((tx) => loadReplayState(tx, worldId)))).toBe(last.stateHash);
    const exported = await exportReplay(legacy, worldId);
    expect(exported.version).toBe(2);
    expect(exported.origin).toEqual(archive.origin);
    expect(exported.months.map((month) => month.stateHash)).toEqual(archive.months.map((month) => month.stateHash));
    expect(replayArchive(exported, 12)).toEqual(replayArchive(archive, 12));
  } finally {
    await legacy.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60000);
