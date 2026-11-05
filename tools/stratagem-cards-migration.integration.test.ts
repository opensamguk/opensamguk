import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';

type Row = Record<string, unknown>;
type PgClient = {
  connect(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => PgClient;
};
const directory = new URL('../packages/db/prisma/migrations/', import.meta.url),
  marker = '20261117000000_stratagem_cards_state';

async function ownDatabase(run: (client: PgClient) => Promise<void>) {
  if (!process.env.TEST_DATABASE_URL) throw Error('전용 계략 패 migration DB가 필요합니다.');
  const target = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
    adminUrl = new URL(target);
  if (
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    target.searchParams.has('host') ||
    target.searchParams.has('port')
  )
    throw Error('loopback 전용 DB를 확인하세요.');
  const name = `cards_upgrade_${randomUUID().replaceAll('-', '')}_test`;
  if (!/^cards_upgrade_[a-f0-9]{32}_test$/.test(name)) throw Error('생성할 DB 이름을 확인하세요.');
  target.pathname = `/${name}`;
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.href }),
    client = new Client({ connectionString: target.href });
  const errors: unknown[] = [];
  let oid: string | undefined,
    before: Row[] | undefined,
    created = false;
  await admin.connect();
  try {
    before = (await admin.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows;
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    oid = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows[0]?.oid as
      string | undefined;
    if (!oid) throw Error('생성한 DB OID가 없습니다.');
    console.info(JSON.stringify({ event: 'cards-migration-created', name, oid }));
    await client.connect();
    await run(client);
  } catch (error) {
    errors.push(error);
  } finally {
    let disconnected = false;
    try {
      await client.end();
      disconnected = true;
    } catch (error) {
      errors.push(error);
    }
    try {
      if (created) {
        if (!oid || !disconnected) errors.push(Error('소유 DB의 연결·OID를 확인하지 못해 보존합니다.'));
        else {
          expect((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows).toEqual(
            [{ oid }],
          );
          expect((await confirmDisconnectedDatabase(admin, name, oid)).connections).toBe(0);
          await admin.query(`DROP DATABASE "${name}"`);
          expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
          console.info(JSON.stringify({ event: 'cards-migration-dropped', name, oid, absent: true }));
        }
      }
      if (before)
        expect((await admin.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows).toEqual(
          before,
        );
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
  if (errors.length) throw new AggregateError(errors, '계략 패 migration과 소유 DB 정리를 확인하세요.');
}

it.each(['empty', 'upgrade'] as const)(
  'AC-P2-23 실제 %s DB에서 기존44개 뒤 migration45는 구형 행을 보존한다',
  async (mode) => {
    await ownDatabase(async (client) => {
      const names = (await readdir(directory)).filter((name) => /^\d{14}_/.test(name)).sort();
      const markerIndex = names.indexOf(marker);
      expect(markerIndex).toBe(44);
      for (const name of names.slice(0, markerIndex))
        await client.query(await readFile(new URL(`${name}/migration.sql`, directory), 'utf8'));
      if (mode === 'upgrade') {
        const initial = commandInitial();
        await client.query(
          'INSERT INTO "World" (id,name,"scenarioKey","mapKey","unitSetKey",seed,"startYear","turnTermMinutes","initialStateHash","statRules","unitSet") VALUES ($1,$1,$2,$3,$4,$5,$6,60,$7,$8,$9)',
          [
            'cards-legacy',
            initial.scenarioKey,
            initial.mapKey,
            initial.unitSetKey,
            initial.seed,
            initial.startYear,
            'legacy-state-hash',
            initial.statRules,
            initial.unitSet,
          ],
        );
      }
      const before = (await client.query('SELECT * FROM "World" ORDER BY id')).rows;
      expect(before).toHaveLength(mode === 'upgrade' ? 1 : 0);
      await client.query(await readFile(new URL(`${marker}/migration.sql`, directory), 'utf8'));
      const after = (await client.query('SELECT * FROM "World" ORDER BY id')).rows;
      expect(
        after.map(({ stratagemCardsState, ...row }) => {
          expect(stratagemCardsState).toBeNull();
          return row;
        }),
      ).toEqual(before);
      expect(
        (
          await client.query(
            `SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='World' AND column_name='stratagemCardsState'`,
          )
        ).rows,
      ).toEqual([{ data_type: 'jsonb', is_nullable: 'YES', column_default: null }]);
      for (const name of names.slice(markerIndex + 1))
        await client.query(await readFile(new URL(`${name}/migration.sql`, directory), 'utf8'));
      expect((await client.query('SELECT * FROM "World" ORDER BY id')).rows).toEqual(after);
    });
  },
);
