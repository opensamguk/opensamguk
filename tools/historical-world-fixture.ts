import { randomUUID } from 'node:crypto';
import type { WorldInit } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';

type Sql = { query(sql: string, values?: unknown[]): Promise<unknown> };

// AC-M3-04: 2026-11 관리자 migration 이전 열만 쓴다. 최신 엔진 저장 계약과 분리한다.
export async function insertHistoricalWorld(client: Sql, initial: WorldInit, name: string) {
  const worldId = randomUUID();
  await client.query(
    'INSERT INTO "World" (id,name,"scenarioKey","mapKey","unitSetKey",seed,"startYear","turnTermMinutes","initialStateHash","statRules","unitSet","replayOrigin") VALUES ($1,$2,$3,$4,$5,$6,$7,60,$8,$9::jsonb,$10::jsonb,$11::jsonb)',
    [
      worldId,
      name,
      initial.scenarioKey,
      initial.mapKey,
      initial.unitSetKey,
      initial.seed,
      initial.startYear,
      hashState(initial),
      JSON.stringify(initial.statRules),
      JSON.stringify(initial.unitSet),
      JSON.stringify({ initial }),
    ],
  );
  const insert = async (table: string, columns: string[], rows: unknown[]) => {
    const fields = columns.map((column) => '"' + column + '"').join(',');
    if (rows.length)
      await client.query(
        `INSERT INTO "${table}" (${fields}) SELECT ${fields} FROM json_populate_recordset(NULL::"${table}",$1::json)`,
        [JSON.stringify(rows)],
      );
  };
  await insert(
    'Nation',
    [
      'worldId',
      'id',
      'name',
      'color',
      'gold',
      'rice',
      'description',
      'tech',
      'philosophy',
      'level',
      'capitalCityKey',
      'isNpc',
    ],
    initial.nations.map((nation) => ({ ...nation, worldId, capitalCityKey: null })),
  );
  await insert(
    'City',
    [
      'worldId',
      'cityKey',
      'name',
      'level',
      'region',
      'x',
      'y',
      'connections',
      'nationId',
      'population',
      'populationMax',
      'agriculture',
      'agricultureMax',
      'commerce',
      'commerceMax',
      'security',
      'securityMax',
      'defence',
      'defenceMax',
      'wall',
      'wallMax',
      'trust',
      'supplied',
    ],
    initial.cities.map((city) => ({ ...city, worldId })),
  );
  for (const nation of initial.nations)
    await client.query('UPDATE "Nation" SET "capitalCityKey"=$1 WHERE "worldId"=$2 AND id=$3', [
      nation.capitalCityKey,
      worldId,
      nation.id,
    ]);
  await insert(
    'General',
    [
      'worldId',
      'id',
      'userId',
      'affinity',
      'name',
      'portraitId',
      'nationId',
      'cityKey',
      'leadership',
      'strength',
      'intel',
      'officerLevel',
      'birthYear',
      'deathYear',
      'activeFromYear',
      'personality',
      'special',
      'gold',
      'rice',
      'crew',
      'crewType',
      'train',
      'atmos',
      'experience',
      'dedication',
      'age',
      'injury',
      'nextTurnTick',
    ],
    initial.generals.map((general) => ({ ...general, worldId })),
  );
  return worldId;
}
