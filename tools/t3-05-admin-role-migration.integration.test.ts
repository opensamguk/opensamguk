import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { testDatabaseUrl } from './test-database';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';

type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(dbRequire.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Pg;
};
const root = new URL('../packages/db/prisma/migrations/', import.meta.url);
const marker = '20261103000000_admin_role_audit';
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const executions = new Set<Promise<unknown>>();
const executionErrors: unknown[] = [];
function it(name: string, action: () => Promise<void>) {
  test(name, () => {
    const execution = Promise.resolve().then(action);
    executions.add(execution);
    void execution.then(
      () => executions.delete(execution),
      (error: unknown) => {
        executionErrors.push(error);
        executions.delete(execution);
      },
    );
    return execution;
  });
}
async function settleExecutions() {
  while (executions.size) await Promise.allSettled([...executions]);
}
beforeEach(settleExecutions);
afterAll(async () => {
  await settleExecutions();
  if (executionErrors.length) throw new AggregateError(executionErrors, '관리자 migration 실행·정리 실패');
});

async function catalog(client: Pg) {
  return (await client.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows;
}
async function snapshot(client: Pg, tables: string[]) {
  const hash = createHash('sha256');
  for (const table of tables) {
    const row = table === 'User' ? "to_jsonb(t)-'role'" : 'to_jsonb(t)';
    const result = await client.query(
      `SELECT COALESCE(jsonb_agg(${row} ORDER BY (${row})::text),'[]'::jsonb)::text AS body FROM ${quote(table)} t`,
    );
    hash.update(table + '\n' + String(result.rows[0]!.body) + '\n');
  }
  return hash.digest('hex');
}
async function sequences(client: Pg, names: string[]) {
  const values = [];
  for (const name of names)
    values.push({ name, rows: (await client.query(`SELECT last_value::text,is_called FROM ${quote(name)}`)).rows });
  return values;
}

it('T3-05 관리자 migration은 두 정식 월드·기존 계정과 모든 기존 표·sequence를 보존한다', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('전용 시험 접속값이 필요합니다.');
  const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('loopback 시험 서버가 필요합니다.');
  for (const key of source.searchParams.keys())
    if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
      throw new Error('접속 대상 질의 인자는 쓸 수 없습니다.');
  const name = `t305_role_migration_${randomUUID().replaceAll('-', '')}_test`;
  if (!/^t305_role_migration_[a-f0-9]{32}_test$/.test(name)) throw new Error('자체 DB 이름을 확인하세요.');
  const adminUrl = new URL(source),
    target = new URL(source);
  adminUrl.pathname = '/postgres';
  target.pathname = '/' + name;
  const admin = new Client({ connectionString: adminUrl.href }),
    client = new Client({ connectionString: target.href });
  let db: ReturnType<typeof createDb> | undefined,
    created = false,
    bodyPassed = false;
  let oid: unknown,
    beforeCatalog: Record<string, unknown>[] = [],
    bodyError: unknown;
  const cleanupErrors: unknown[] = [];
  let preservedHash: string | undefined,
    tableCount = 0,
    connectionsBeforeDrop: number | null = null,
    dropped = false;
  try {
    await admin.connect();
    beforeCatalog = await catalog(admin);
    expect(beforeCatalog.some((row) => row.datname === name)).toBe(false);
    await admin.query(`CREATE DATABASE ${quote(name)}`);
    created = true;
    oid = (await catalog(admin)).find((row) => row.datname === name)?.oid;
    expect(typeof oid).toBe('string');
    await client.connect();
    const migrations = (await readdir(root)).filter((value) => /^\d{14}_/.test(value)).sort();
    const index = migrations.indexOf(marker);
    expect(index).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, index))
      await client.query(await readFile(new URL(`${migration}/migration.sql`, root), 'utf8'));
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 't305-preservation',
    });
    expect(initial.nations).toHaveLength(21);
    expect(initial.generals).toHaveLength(491);
    db = createDb(target.href);
    await saveInitialWorld(db, initial, { name: '기존 정식 월드 하나', turnTermMinutes: 60, endYear: 201 });
    await saveInitialWorld(
      db,
      { ...initial, seed: 't305-preservation-two' },
      { name: '기존 정식 월드 둘', turnTermMinutes: 60, endYear: 201 },
    );
    expect(await db.general.count()).toBe(982);
    const ids: string[] = [];
    for (const [index, status] of ['ACTIVE', 'SANCTIONED', 'WITHDRAWN'].entries()) {
      const id = randomUUID();
      ids.push(id);
      await client.query(
        'INSERT INTO "User" (id,email,"passwordHash",status,"createdAt","emailVerifiedAt") VALUES ($1,$2,$3,$4::"UserStatus",$5,$6)',
        [
          id,
          `${randomUUID()}@example.test`,
          'preserved-hash',
          status,
          new Date('2026-01-01T12:34:56.789Z'),
          index === 0 ? new Date('2026-02-01T12:34:56.789Z') : null,
        ],
      );
      await client.query('INSERT INTO "Session" (id,"userId","expiresAt") VALUES ($1,$2,$3)', [
        `fixture-session-${index}`,
        id,
        new Date('2027-01-01T00:00:00Z'),
      ]);
      await client.query(
        'INSERT INTO "AccountToken" (id,"userId",purpose,"expiresAt") VALUES ($1,$2,\'VERIFY_EMAIL\',$3)',
        [`fixture-token-${index}`, id, new Date('2027-01-01T00:00:00Z')],
      );
      await client.query(
        'INSERT INTO "ConsentRecord" (id,"userId","docType",version) VALUES ($1,$2,\'TERMS\',\'fixture-only\')',
        [randomUUID(), id],
      );
    }
    const tables = (
      await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    ).rows.map((row) => String(row.tablename));
    const seqNames = (
      await client.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")
    ).rows.map((row) => String(row.sequencename));
    tableCount = tables.length;
    preservedHash = await snapshot(client, tables);
    const oldSequences = await sequences(client, seqNames);
    await client.query(await readFile(new URL(`${marker}/migration.sql`, root), 'utf8'));
    expect(await snapshot(client, tables)).toBe(preservedHash);
    expect(await sequences(client, seqNames)).toEqual(oldSequences);
    expect(await db.user.findMany({ where: { id: { in: ids } }, select: { role: true } })).toEqual([
      { role: 'USER' },
      { role: 'USER' },
      { role: 'USER' },
    ]);
    expect(await db.auditLog.count()).toBe(0);
    expect(
      (
        await client.query(
          "SELECT is_nullable,udt_name,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='User' AND column_name='role'",
        )
      ).rows,
    ).toEqual([{ is_nullable: 'NO', udt_name: 'UserRole', column_default: '\'USER\'::"UserRole"' }]);
    bodyPassed = true;
  } catch (error) {
    bodyError = error;
  } finally {
    try {
      const closed = await Promise.allSettled([client.end(), ...(db ? [db.$disconnect()] : [])]);
      for (const result of closed) if (result.status === 'rejected') cleanupErrors.push(result.reason);
      expect(closed.every((result) => result.status === 'fulfilled')).toBe(true);
      if (created) {
        expect((await catalog(admin)).find((row) => row.datname === name)).toEqual({ datname: name, oid });
        for (let index = 0; index <= 20; index++) {
          connectionsBeforeDrop = Number(
            (await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]!
              .count,
          );
          if (connectionsBeforeDrop === 0 || index === 20) break;
          await delay(50);
        }
        expect(connectionsBeforeDrop).toBe(0);
        expect((await catalog(admin)).find((row) => row.datname === name)).toEqual({ datname: name, oid });
        if (bodyPassed) {
          await admin.query(`DROP DATABASE ${quote(name)}`);
          dropped = true;
          expect(await catalog(admin)).toEqual(beforeCatalog);
        }
      }
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try {
        await admin.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    console.info(
      'T3-05 migration 보존과 정리',
      JSON.stringify({
        name,
        oid,
        bodyPassed,
        tableCount,
        preservedHash,
        formalWorlds: 2,
        nationsPerWorld: 21,
        npcPerWorld: 491,
        connectionsBeforeDrop,
        dropped,
        failedDatabasePreserved: created && !dropped,
      }),
    );
  }
  const errors = [...(bodyError ? [bodyError] : []), ...cleanupErrors];
  if (errors.length) throw new AggregateError([...new Set(errors)], '관리자 migration 본문·정리 실패');
});
