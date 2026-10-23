import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { resourceHash } from '../apps/engine/src/replay';

type PgClient = {
  connect(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const require = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
const { Client } = require('pg') as { Client: new (options: { connectionString: string }) => PgClient };
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const client = new Client({ connectionString: url });
const schema = `t213_${randomUUID().replaceAll('-', '')}`;
const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
const policyMigration = '20261023050000_default_policy';
const initial = commandInitial();
initial.generals[0]!.userId = 'migration-human';
const worldId = randomUUID();
const endedWorldId = randomUUID();
const policySql = await readFile(new URL(`${policyMigration}/migration.sql`, migrations), 'utf8');

async function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  if (![table, ...keys].every((key) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)))
    throw new Error('시험 식별자가 올바르지 않습니다.');
  await client.query(
    `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')})`,
    Object.values(row),
  );
}

beforeAll(async () => {
  await client.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  for (const directory of (await readdir(migrations))
    .filter((name) => /^\d/.test(name) && name < policyMigration)
    .sort())
    await client.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'));
  await insert('World', {
    id: worldId,
    name: '전환 시험',
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    seed: initial.seed,
    startYear: initial.startYear,
    turnTermMinutes: 30,
    status: 'PAUSED',
    clockTick: 60000,
    actionSequence: 7,
    initialStateHash: hashState(initial),
    statRules: initial.statRules,
    unitSet: initial.unitSet,
    replayOrigin: { version: 1, initial, initialStateHash: hashState(initial), resourceHash: resourceHash(initial) },
  });
  await insert('User', {
    id: 'migration-human',
    email: 'migration-human@example.invalid',
    passwordHash: 'fixture-only',
  });
  for (const nation of initial.nations) await insert('Nation', { ...nation, worldId, capitalCityKey: null });
  for (const city of initial.cities) await insert('City', { ...city, worldId });
  for (const general of initial.generals) await insert('General', { ...general, worldId });
  for (let slot = 0; slot < 29; slot++)
    await insert('GeneralTurn', { worldId, generalId: 1, slot, commandKey: 'rest', args: {} });
  await insert('World', {
    id: endedWorldId,
    name: '끝난 옛 월드',
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    seed: initial.seed,
    startYear: initial.startYear,
    turnTermMinutes: 30,
    status: 'ENDED',
    initialStateHash: hashState(initial),
    statRules: initial.statRules,
    unitSet: initial.unitSet,
  });
  for (const nation of initial.nations)
    await insert('Nation', { ...nation, worldId: endedWorldId, capitalCityKey: null });
  for (const city of initial.cities) await insert('City', { ...city, worldId: endedWorldId });
  await insert('General', { ...initial.generals[1]!, worldId: endedWorldId });
});
afterAll(async () => {
  await client.query('ROLLBACK');
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
});

it('부분 칸이면 DDL까지 롤백하고 정상 전환 준비는 옛 기록과 활동·sequence를 보존한다', async () => {
  const before = (await client.query('SELECT "replayOrigin","clockTick","actionSequence" FROM "World"')).rows;
  await expect(client.query(policySql)).rejects.toThrow('Invalid legacy turn slot set');
  await client.query('ROLLBACK');
  expect(
    (
      await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='GeneralTurn' AND column_name='explicit'`,
        [schema],
      )
    ).rows,
  ).toHaveLength(0);
  expect((await client.query('SELECT slot FROM "GeneralTurn"')).rows).toHaveLength(29);
  await insert('GeneralTurn', { worldId, generalId: 1, slot: 29, commandKey: 'rest', args: {} });
  for (const invalid of [-1, 30]) {
    await client.query('UPDATE "GeneralTurn" SET slot=$1 WHERE "worldId"=$2 AND "generalId"=1 AND slot=29', [
      invalid,
      worldId,
    ]);
    await expect(client.query(policySql)).rejects.toThrow('Invalid legacy turn slot set');
    await client.query('ROLLBACK');
    await client.query('UPDATE "GeneralTurn" SET slot=29 WHERE "worldId"=$1 AND "generalId"=1 AND slot=$2', [
      worldId,
      invalid,
    ]);
  }
  await insert('InputEvent', {
    worldId,
    userId: 'system:policy',
    kind: 'system.policy.enable',
    idempotencyKey: 'existing',
    payload: {},
    status: 'PENDING',
  });
  await expect(client.query(policySql)).rejects.toThrow('Policy transition already exists');
  await client.query('ROLLBACK');
  await client.query(`DELETE FROM "InputEvent" WHERE "worldId"=$1 AND "idempotencyKey"='existing'`, [worldId]);
  await client.query(policySql);
  expect((await client.query('SELECT "replayOrigin","clockTick","actionSequence" FROM "World"')).rows).toEqual(before);
  expect((await client.query('SELECT "policyFromSequence" FROM "World"')).rows[0]!.policyFromSequence).toBeNull();
  const generals = (await client.query('SELECT "defaultPolicy","lastActiveTick","lastActiveAt" FROM "General"')).rows;
  expect(generals.every((g) => g.defaultPolicy === null && g.lastActiveTick === null && g.lastActiveAt === null)).toBe(
    true,
  );
  expect(
    (await client.query('SELECT slot FROM "GeneralTurn" WHERE "generalId"=1 AND explicit=true')).rows,
  ).toHaveLength(30);
  expect(
    (await client.query('SELECT slot FROM "GeneralTurn" WHERE "generalId"=2 AND explicit=false')).rows,
  ).toHaveLength(30);
  const marker = (await client.query('SELECT status,sequence,payload,result FROM "InputEvent"')).rows[0]!;
  expect(marker).toEqual({
    status: 'PENDING',
    sequence: null,
    result: null,
    payload: { version: 5, emptySlots: initial.generals.filter((g) => g.id !== 1).map((g) => g.id) },
  });
  expect((await client.query('SELECT slot FROM "GeneralTurn" WHERE "worldId"=$1', [endedWorldId])).rows).toHaveLength(
    0,
  );
  expect((await client.query('SELECT id FROM "InputEvent" WHERE "worldId"=$1', [endedWorldId])).rows).toHaveLength(0);
  await expect(
    insert('GeneralTurn', { worldId, generalId: 1, slot: 30, commandKey: 'rest', args: {} }),
  ).rejects.toThrow();
  for (const kind of ['general.setPolicy', 'system.policy.enable']) {
    const input = {
      worldId,
      userId: 'migration-human',
      generalId: 1,
      kind,
      idempotencyKey: randomUUID(),
      payload: {},
      status: 'PENDING',
    };
    if (kind === 'general.setPolicy') await insert('InputEvent', input);
    await expect(insert('InputEvent', { ...input, idempotencyKey: randomUUID() })).rejects.toThrow();
  }
  await expect(
    client.query(`UPDATE "GeneralTurn" SET explicit=false,"commandKey"='farm' WHERE "generalId"=1 AND slot=0`),
  ).rejects.toThrow();
  const columns = (
    await client.query(
      `SELECT column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='GeneralTurn' AND column_name='explicit'`,
      [schema],
    )
  ).rows;
  expect(columns[0]!.column_default).toBeNull();
  for (const key of ['first', 'second'])
    await insert('InputEvent', {
      worldId,
      userId: 'migration-human',
      generalId: 1,
      kind: 'general.active',
      idempotencyKey: key,
      payload: {},
      status: 'PENDING',
    }).catch((error) => {
      if (key !== 'second') throw error;
    });
  expect((await client.query(`SELECT id FROM "InputEvent" WHERE kind='general.active'`)).rows).toHaveLength(1);
});
