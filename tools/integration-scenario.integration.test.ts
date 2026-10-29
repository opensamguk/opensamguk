import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterAll, describe, expect, it, onTestFailed } from 'vitest';
import { createDb, type PrismaClient } from '../packages/db/src/index';
import { TICKS_PER_MONTH } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { loadInitialWorld, loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { initializeResources } from './init-resources';
import { initializeIntegrationResources, integrationResourceRows } from './integration-resources';
import { fileURLToPath } from 'node:url';
import { testDatabaseUrl } from './test-database';

const root = new URL('../', import.meta.url);
const selection = {
  scenario: 'integration191',
  map: 'integration',
  statRules: 'five-stats',
  portraitMap: '191-map',
  seed: 'integration191-pg',
};
interface PgClient {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}
function nativeClient(connectionString: string): PgClient {
  const dbRequire = createRequire(new URL('packages/db/package.json', root));
  const require = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
  const { Client } = require('pg') as { Client: new (options: { connectionString: string }) => PgClient };
  return new Client({ connectionString });
}
interface Fixture {
  db: PrismaClient;
  native: PgClient;
  url: URL;
}

function ownedDatabase(initialize = true) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('전용 TEST_DATABASE_URL이 필요합니다.');
  const reference = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  const name = `integration191_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(reference);
  url.pathname = `/${name}`;
  testDatabaseUrl({ TEST_DATABASE_URL: url.href, DATABASE_URL: process.env.DATABASE_URL });
  const adminUrl = new URL(reference);
  adminUrl.pathname = '/postgres';
  const admin = nativeClient(adminUrl.href);
  const native = nativeClient(url.href);
  let adminConnected = false;
  let adminConnectAttempted = false;
  let nativeConnectAttempted = false;
  let created = false;
  let createAttempted = false;
  let baselineAbsent = false;
  let failed = false;
  let oid: string | undefined;
  let db: PrismaClient | undefined;
  let fixture: Fixture | undefined;
  let closing: Promise<void> | undefined;
  const cleanupErrors: unknown[] = [];
  const owner = {
    fail() {
      failed = true;
    },
    async setup(): Promise<Fixture> {
      adminConnectAttempted = true;
      await admin.connect();
      adminConnected = true;
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
      baselineAbsent = true;
      createAttempted = true;
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      oid = (await admin.query<{ oid: string }>('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [name]))
        .rows[0]!.oid;
      nativeConnectAttempted = true;
      await native.connect();
      const migrations = new URL('packages/db/prisma/migrations/', root);
      const names = (await readdir(migrations, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map(({ name }) => name)
        .sort();
      for (const name of names)
        await native.query(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
      db = createDb(url.href);
      if (initialize)
        await initializeResources(db, await readFile(new URL('packages/db/sql/resources-init.sql', root), 'utf8'));
      fixture = { db, native, url };
      return fixture;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closing = (async () => {
        const receipt = {
          event: 'integration-scenario-cleanup',
          name,
          oid: oid ?? null,
          createAttempted,
          baselineAbsent,
          created,
          failed,
          identityMatched: false,
          oidRecovered: false,
          connections: null as number | null,
          dropped: false,
          catalogAbsent: false,
          prismaClosed: false,
          nativeClosed: !nativeConnectAttempted,
          adminClosed: !adminConnectAttempted,
          errors: 0,
        };
        try {
          // 재접속 시험이 바꾼 최신 Prisma 연결도 이 소유자가 닫는다.
          await (fixture?.db ?? db)?.$disconnect();
          receipt.prismaClosed = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          if (nativeConnectAttempted) {
            await native.end();
            receipt.nativeClosed = true;
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (adminConnected && baselineAbsent && createAttempted)
          try {
            const identities = (
              await admin.query<{ oid: string }>('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [name])
            ).rows;
            expect(identities.length).toBeLessThanOrEqual(1);
            if (identities.length === 0) {
              expect(created).toBe(false);
              receipt.catalogAbsent = true;
            } else {
              const observedOid = identities[0]!.oid;
              expect(observedOid).toMatch(/^[1-9]\d*$/);
              if (oid === undefined) {
                // 생성 응답 유실 때도 사전에 없던 이 UUID 이름만 읽어서 보존한다.
                oid = observedOid;
                receipt.oidRecovered = true;
                failed = true;
              }
              receipt.oid = oid;
              expect(observedOid).toBe(oid);
              receipt.identityMatched = true;
              // 소켓 종료 뒤 PostgreSQL의 backend 정착을 기다린다.
              for (let attempt = 0; attempt <= 20; attempt++) {
                const activity = await admin.query<{ count: number }>(
                  'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1',
                  [name],
                );
                expect(activity.rows).toHaveLength(1);
                receipt.connections = activity.rows[0]!.count;
                if (receipt.connections === 0 || attempt === 20) break;
                await delay(50);
              }
              expect(receipt.connections).toBe(0);
              expect(
                (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [name])).rows,
              ).toEqual([{ oid }]);
              if (!failed && cleanupErrors.length === 0) {
                await admin.query(`DROP DATABASE "${name}"`);
                receipt.dropped = true;
                expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
                receipt.catalogAbsent = true;
              }
            }
          } catch (error) {
            cleanupErrors.push(error);
          }
        try {
          if (adminConnectAttempted) {
            await admin.end();
            receipt.adminClosed = true;
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
        receipt.failed = failed || cleanupErrors.length > 0;
        receipt.errors = cleanupErrors.length;
        console.log(JSON.stringify(receipt));
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '자기 DB 정리가 실패했습니다.');
      })();
      return closing;
    },
  };
  return owner;
}

const databaseExecutions = new Set<Promise<void>>();
const databaseFailures: unknown[] = [];
async function settleDatabases() {
  while (databaseExecutions.size) await Promise.allSettled([...databaseExecutions]);
}
beforeEach(settleDatabases);
afterAll(async () => {
  await settleDatabases();
  if (databaseFailures.length) throw new AggregateError(databaseFailures, '정식 시나리오 본문·자기 DB 정리 실패');
});
function withDatabase(action: (value: Fixture) => Promise<void>, initialize = true): Promise<void> {
  const owned = ownedDatabase(initialize);
  onTestFailed(() => owned.fail());
  const execution = (async () => {
    const errors: unknown[] = [];
    try {
      await action(await owned.setup());
    } catch (error) {
      owned.fail();
      errors.push(error);
    }
    try {
      await owned.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, '시험과 자기 DB 정리가 실패했습니다.');
  })();
  databaseExecutions.add(execution);
  void execution.then(
    () => databaseExecutions.delete(execution),
    (error: unknown) => {
      databaseFailures.push(error);
      databaseExecutions.delete(execution);
    },
  );
  return execution;
}

async function preservedWorld(db: PrismaClient, worldId: string) {
  return {
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    state: await readWorldState(db, worldId),
    turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    inputs: await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    yearbooks: await db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } }),
  };
}

async function catalog(db: PrismaClient) {
  return db.gameResource.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }, { version: 'asc' }] });
}

it('AC-INT-04 정식 게시를 재실행해도 원래 게시 자원과 구형191년 월드는 그대로다', async () => {
  await withDatabase(async ({ db }) => {
    const old = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'old-191-preserved' });
    const { worldId } = await saveInitialWorld(db, old, {
      name: '기존191년',
      turnTermMinutes: 60,
      endYear: null,
      replayFormat: 'legacy',
    });
    const beforeWorld = await preservedWorld(db, worldId);
    const before = await catalog(db);
    expect(await initializeIntegrationResources(db)).toEqual({ inserted: 4, existing: 0 });
    const once = await catalog(db);
    expect(await initializeIntegrationResources(db)).toEqual({ inserted: 0, existing: 4 });
    expect(await catalog(db)).toEqual(once);
    for (const row of before) expect(once).toContainEqual(row);
    expect(await preservedWorld(db, worldId)).toEqual(beforeWorld);
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    expect(world.operationalMap).toBeNull();
    expect(world.ruleFeatures).toEqual([]);
  });
});

it.each(['content', 'contentHash', 'status', 'source'] as const)(
  'AC-INT-04 마지막 게시 자원의 %s 충돌은 앞의 삽입까지 롤백한다',
  async (field) => {
    await withDatabase(async ({ db }) => {
      const row = (await integrationResourceRows()).at(-1)!;
      await db.gameResource.create({
        data: {
          kind: row.kind,
          name: row.name,
          version: 1,
          content: row.content,
          contentHash: row.contentHash,
          source: row.source,
          status: 'PUBLISHED',
          publishedAt: new Date(),
          ...(field === 'content'
            ? { content: {} }
            : field === 'status'
              ? { status: 'DRAFT' as const, publishedAt: null }
              : { [field]: field === 'contentHash' ? '0'.repeat(64) : 'conflict' }),
        },
      });
      const before = await catalog(db);
      await expect(initializeIntegrationResources(db)).rejects.toThrow('기존 통합판 게시 자원과 다릅니다');
      expect(await catalog(db)).toEqual(before);
    });
  },
);

it('AC-INT-04 실제CLI는 게시된 191년61거점·21국·491명·초상·5능력치를 생성한다', async () => {
  await withDatabase(async ({ db, url }) => {
    await initializeIntegrationResources(db);
    const command = process.execPath;
    const args = [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('apps/engine/src/cli/createWorld.ts', root)),
      '--published',
      '--scenario',
      selection.scenario,
      '--map',
      selection.map,
      '--stat-rules',
      selection.statRules,
      '--portrait-map',
      selection.portraitMap,
      '--seed',
      selection.seed,
      '--name',
      '정식191년CLI',
      '--turn-term',
      '60',
      '--end-year',
      '201',
    ];
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url.href },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout!.resume();
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
      child.once('error', () => clearTimeout(timeout));
    });
    expect(code, stderr).toBe(0);
    const world = await db.world.findFirstOrThrow({ where: { name: '정식191년CLI' } });
    expect([
      await db.city.count({ where: { worldId: world.id } }),
      await db.nation.count({ where: { worldId: world.id } }),
      await db.general.count({ where: { worldId: world.id } }),
    ]).toEqual([61, 21, 491]);
    expect(world.ruleFeatures).toEqual(['five-stats', 'operational-map']);
    expect(
      await db.general.count({
        where: { worldId: world.id, OR: [{ portraitId: null }, { politics: null }, { charm: null }] },
      }),
    ).toBe(0);
    expect(hashState(await readWorldState(db, world.id))).toBe(hashState(await loadInitialWorldFromDb(db, selection)));
  });
});

describe('AC-INT-04 정식191년 첫 달·재시작·재생·다른 월드 격리', () => {
  const owned = ownedDatabase();
  let fixture: Fixture;
  let worldId: string;
  let otherId: string;
  let otherBefore: unknown;
  let preparation: Promise<void> | undefined;
  let execution: Promise<void> | undefined;
  beforeAll(() => {
    preparation = (async () => {
      fixture = await owned.setup();
      await initializeIntegrationResources(fixture.db);
      const initial = await loadInitialWorldFromDb(fixture.db, selection);
      ({ worldId } = await saveInitialWorld(fixture.db, initial, {
        name: '정식191년 첫 달',
        turnTermMinutes: 60,
        endYear: 201,
      }));
      ({ worldId: otherId } = await saveInitialWorld(fixture.db, initial, {
        name: '격리된 정식191년',
        turnTermMinutes: 60,
        endYear: 201,
      }));
      otherBefore = await preservedWorld(fixture.db, otherId);
    })();
    return preparation;
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    for (const body of [preparation, execution])
      try {
        await body;
      } catch (error) {
        owned.fail();
        errors.push(error);
      }
    try {
      await owned.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, '정식191년 본문·자기 DB 정리 실패');
  });
  beforeEach(async () => {
    onTestFailed(() => owned.fail());
    await execution?.catch(() => owned.fail());
  });
  it('491명 첫 달 정산은 연감을 저장하고 다른 월드를 보존한다', () => {
    execution = (async () => {
      const { db } = fixture;
      await controlClock(db, worldId, 'start');
      const lease = await acquireLease(db, worldId);
      if (!lease) throw new Error('실행권 누락');
      try {
        const loop = new TurnLoop(db, lease);
        for (let tick = 1000; tick <= TICKS_PER_MONTH; tick += 1000) {
          await renewLease(db, lease);
          await loop.advanceTo(tick);
        }
      } finally {
        await releaseLease(db, lease);
      }
      expect(await db.yearbookSnapshot.count({ where: { worldId, tick: TICKS_PER_MONTH } })).toBe(1);
      expect(await preservedWorld(db, otherId)).toEqual(otherBefore);
      expect(await db.yearbookSnapshot.count({ where: { worldId: otherId } })).toBe(0);
    })();
    return execution;
  });
  it('첫 달의 연감 해시가 같은 시드의 전체 장수 재생과 일치한다', () => {
    execution = (async () => {
      const snapshot = await fixture.db.yearbookSnapshot.findUniqueOrThrow({
        where: { worldId_tick: { worldId, tick: TICKS_PER_MONTH } },
      });
      const archive = await exportReplay(fixture.db, worldId);
      expect(replayArchive(archive, 1)).toEqual([{ tick: TICKS_PER_MONTH, stateHash: snapshot.stateHash }]);
    })();
    return execution;
  });
  it('기존 연결·리스 종료 뒤 새 연결·엔진 루프가 다음 달을 진행하고 다른 월드를 보존한다', () => {
    execution = (async () => {
      const beforeRestart = await readWorldState(fixture.db, worldId);
      await fixture.db.$disconnect();
      fixture.db = createDb(fixture.url.href);
      const db = fixture.db;
      expect(await readWorldState(db, worldId)).toEqual(beforeRestart);
      const lease = await acquireLease(db, worldId);
      if (!lease) throw new Error('재시작 실행권 누락');
      try {
        const loop = new TurnLoop(db, lease);
        for (let tick = TICKS_PER_MONTH + 1000; tick <= 2 * TICKS_PER_MONTH; tick += 1000) {
          await renewLease(db, lease);
          await loop.advanceTo(tick);
        }
      } finally {
        await releaseLease(db, lease);
      }
      const snapshots = await db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } });
      expect(snapshots).toHaveLength(2);
      expect(await preservedWorld(db, otherId)).toEqual(otherBefore);
    })();
    return execution;
  });
  it('재시작 전후 두 달의 모든 월 해시가 같은 시드 재생과 일치한다', () => {
    execution = (async () => {
      const snapshots = await fixture.db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } });
      expect(snapshots.map(({ tick }) => tick)).toEqual([TICKS_PER_MONTH, 2 * TICKS_PER_MONTH]);
      expect(replayArchive(await exportReplay(fixture.db, worldId), 2)).toEqual(
        snapshots.map(({ tick, stateHash }) => ({ tick, stateHash })),
      );
    })();
    return execution;
  });
  it('다음 턴 전에 고정 원장을 바꾸면 새 트랜잭션에서 거부하고 진행을 롤백한다', () => {
    execution = (async () => {
      const { db } = fixture;
      const before = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      const generals = await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } });
      const map = before.operationalMap as Record<string, import('../packages/db/src/index').Prisma.InputJsonValue>;
      await db.world.update({ where: { id: worldId }, data: { operationalMap: { ...map, name: '변조된 지도' } } });
      const lease = await acquireLease(db, worldId);
      if (!lease) throw new Error('검사 실행권 누락');
      try {
        const loop = new TurnLoop(db, lease);
        await expect(loop.advanceTo(2 * TICKS_PER_MONTH + 1000)).rejects.toThrow('생성 기록');
        const after = await db.world.findUniqueOrThrow({ where: { id: worldId } });
        expect([after.clockTick, after.actionSequence, after.monthlyTick]).toEqual([
          before.clockTick,
          before.actionSequence,
          before.monthlyTick,
        ]);
        expect(await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } })).toEqual(generals);
      } finally {
        await releaseLease(db, lease);
      }
    })();
    return execution;
  });
});
