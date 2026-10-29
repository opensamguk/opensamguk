import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID, randomInt } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { initializeResources } from './init-resources';
import { initializeIntegrationResources } from './integration-resources';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';

type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Pg;
};
if (!process.env.TEST_DATABASE_URL) throw new Error('전용 시험 DB가 필요합니다.');
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('loopback 시험 서버가 필요합니다.');
for (const key of source.searchParams.keys())
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    throw new Error('접속 대상 질의 인자는 쓸 수 없습니다.');
const name = 't305_create_migration_' + randomUUID().replaceAll('-', '') + '_test',
  target = new URL(source),
  adminUrl = new URL(source);
target.pathname = '/' + name;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href }),
  gate = new Client({ connectionString: target.href }),
  db = createDb(target.href);
const pending = new Set<Promise<unknown>>(),
  errors: unknown[] = [],
  worlds: string[] = [],
  secrets = new Set<string>(),
  logs: string[] = [];
let oid: string | undefined,
  app: Awaited<ReturnType<typeof buildServer>> | undefined,
  address = '',
  ownerId = '',
  passwordHash = '';
const migration = '20261110000000_world_create_requests',
  origin = 'http://127.0.0.1:5173';
function track<T>(work: () => Promise<T>) {
  const promise = Promise.resolve().then(work);
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    (error) => {
      errors.push(error);
      pending.delete(promise);
    },
  );
  return promise;
}

const operationSignals = new AsyncLocalStorage<AbortSignal>();
function suiteGuard(record: (error: unknown) => void) {
  let failed = false;
  const fail = (error: unknown) => {
    failed = true;
    record(error);
  };
  return {
    get failed() {
      return failed;
    },
    fail,
    async hook<T>(
      label: string,
      work: (signal: AbortSignal) => Promise<T>,
      tracker: <U>(work: () => Promise<U>) => Promise<U> = (work) => Promise.resolve().then(work),
      budgetMs = 110_000,
    ) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const original = tracker(() => operationSignals.run(controller.signal, () => work(controller.signal)));
      try {
        return await Promise.race([
          original,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error('자기 ' + label + ' hook 내부 기한 초과: DB 보존');
              fail(error);
              controller.abort(error);
              reject(error);
            }, budgetMs);
          }),
        ]);
      } catch (error) {
        fail(error);
        controller.abort(error);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
const suite = suiteGuard((error) => errors.push(error));
async function checked<T>(work: () => Promise<T>, signal = operationSignals.getStore()): Promise<T> {
  signal?.throwIfAborted();
  const result = await work();
  signal?.throwIfAborted();
  return result;
}
async function cleanupAttempt(work: () => Promise<unknown>, budgetMs = 10_000, tracked = true) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const original = tracked ? track(work) : Promise.resolve().then(work);
  try {
    await Promise.race([
      original,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('자기 cleanup 정착 기한 초과: DB 보존')), budgetMs);
      }),
    ]);
    return true;
  } catch (error) {
    suite.fail(error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function settle() {
  while (pending.size) await Promise.allSettled([...pending]);
}
function it(title: string, work: (signal: AbortSignal) => Promise<void>) {
  test(
    title,
    ({ onTestFailed }) => {
      const controller = new AbortController();
      onTestFailed(() => {
        controller.abort();
        suite.fail(new Error('실패한 자기 migration DB를 보존합니다.'));
      });
      const promise = track(() => operationSignals.run(controller.signal, () => work(controller.signal)));
      void promise.then(
        () => controller.abort(),
        () => controller.abort(),
      );
      return promise;
    },
    30_000,
  );
}
beforeEach(settle);
async function tables(signal = operationSignals.getStore()) {
  return (
    await checked(
      () => gate.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"),
      signal,
    )
  ).rows.map((row) => String(row.tablename));
}
async function rowsHash(names: readonly string[], signal = operationSignals.getStore()) {
  const hash = createHash('sha256');
  for (const table of names) {
    signal?.throwIfAborted();
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    const rows = await checked(
      () =>
        gate.query(
          "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM " +
            quoted +
            ' t',
        ),
      signal,
    );
    hash.update(table + '\n' + String(rows.rows[0]!.body) + '\n');
  }
  return hash.digest('hex');
}
async function sequences(signal = operationSignals.getStore()) {
  const names = (
    await checked(
      () => gate.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename"),
      signal,
    )
  ).rows;
  const result = [];
  for (const row of names) {
    signal?.throwIfAborted();
    const sequence = String(row.sequencename),
      values = await checked(
        () => gate.query('SELECT last_value::text,is_called FROM "' + sequence.replaceAll('"', '""') + '"'),
        signal,
      );
    result.push({ sequence, ...values.rows[0] });
  }
  return result;
}
let beforeTables: string[] = [],
  beforeHash = '',
  beforeSequences: Awaited<ReturnType<typeof sequences>> = [];
beforeAll(
  () =>
    suite.hook(
      'setup',
      async (signal) => {
        await checked(() => admin.connect(), signal);
        await checked(() => admin.query('SET statement_timeout=10000'), signal);
        await checked(() => admin.query('SET lock_timeout=10000'), signal);
        expect(
          (await checked(async () => admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name]))).rows,
        ).toHaveLength(0);
        await checked(async () => admin.query('CREATE DATABASE "' + name + '"'));
        oid = String(
          (await checked(async () => admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])))
            .rows[0]!.oid,
        );
        await checked(async () => admin.query('ALTER DATABASE "' + name + '" SET statement_timeout=10000'));
        await checked(async () => gate.connect());
        const directory = new URL('../packages/db/prisma/migrations/', import.meta.url),
          all = (await checked(async () => readdir(directory))).filter((value) => /^\d{14}_/.test(value)).sort();
        expect(all.at(-1)).toBe(migration);
        for (const item of all.filter((value) => value !== migration)) {
          signal.throwIfAborted();
          await checked(async () =>
            gate.query(await checked(async () => readFile(new URL(item + '/migration.sql', directory), 'utf8'))),
          );
        }
        await checked(async () =>
          initializeResources(
            db,
            await checked(async () =>
              readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
            ),
          ),
        );
        await checked(async () => initializeIntegrationResources(db));
        passwordHash = await checked(async () => hashPassword(randomUUID()));
        secrets.add(passwordHash);
        const owner = await checked(async () =>
          db.user.create({
            data: { email: randomUUID() + '@example.test', passwordHash, role: 'ADMIN', emailVerifiedAt: new Date() },
          }),
        );
        ownerId = owner.id;
        secrets.add(owner.email);
        const session = newSession(Date.now());
        secrets.add(session.token);
        await checked(async () =>
          db.session.create({ data: { id: session.id, userId: owner.id, expiresAt: session.expiresAt } }),
        );
        await checked(async () =>
          db.accountToken.create({
            data: {
              id: randomUUID(),
              userId: owner.id,
              purpose: 'VERIFY_EMAIL',
              expiresAt: new Date(Date.now() + 60_000),
            },
          }),
        );
        app = await buildServer({
          db,
          publicOrigin: origin,
          logStream: {
            write(chunk: string) {
              logs.push(chunk);
            },
          },
        });
        await checked(async () => app!.ready());
        const binds: unknown[] = [];
        for (let attempt = 0; attempt < 16; attempt++)
          try {
            address = await checked(async () => app!.listen({ host: '127.0.0.1', port: randomInt(20_000, 50_000) }));
            break;
          } catch (error) {
            if (app.server.listening || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
            binds.push(error);
          }
        if (!address) throw new AggregateError(binds, '자기 migration listener bind 실패');
      },
      track,
    ),
  120_000,
);
it('AC-M3-04 새 migration 전 정식 두 월드·사람30·입력·감사·토큰을 준비한다', async (signal) => {
  for (const index of [0, 1]) {
    signal.throwIfAborted();
    const initial = await checked(async () =>
      loadInitialWorldFromDb(db, {
        scenario: 'integration191',
        map: 'integration',
        statRules: 'five-stats',
        portraitMap: '191-map',
        seed: 'create-migration-' + index,
      }),
    );
    const { worldId } = await checked(async () =>
      saveInitialWorld(db, initial, {
        name: 'migration 보존 정식' + index,
        turnTermMinutes: 60,
        endYear: 300,
      }),
    );
    worlds.push(worldId);
    expect(await checked(async () => db.general.count({ where: { worldId } }))).toBe(491);
    expect(await checked(async () => db.nation.count({ where: { worldId } }))).toBe(21);
    await checked(async () => controlClock(db, worldId, 'start'));
    const user =
      index === 0
        ? await checked(async () => db.user.findUniqueOrThrow({ where: { id: ownerId } }))
        : await checked(async () =>
            db.user.create({
              data: { email: randomUUID() + '@example.test', passwordHash, emailVerifiedAt: new Date() },
            }),
          );
    secrets.add(user.email);
    const sid = newSession(Date.now());
    secrets.add(sid.token);
    await checked(async () => db.session.create({ data: { id: sid.id, userId: user.id, expiresAt: sid.expiresAt } }));
    const request = track(async () => {
      signal.throwIfAborted();
      const response = await fetch(address + '/trpc/general.create', {
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { origin, cookie: 'sid=' + sid.token, 'content-type': 'application/json' },
        body: JSON.stringify({
          worldId,
          name: '이전사람' + index,
          portraitId: null,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
        }),
      });
      await response.text();
      signal.throwIfAborted();
      return response.status;
    });
    const settled = Promise.allSettled([request]),
      failures: unknown[] = [];
    try {
      await checked(async () =>
        expect
          .poll(() => checked(() => db.inputEvent.count({ where: { worldId, userId: user.id, status: 'PENDING' } })), {
            timeout: 10_000,
          })
          .toBe(1),
      );
      signal.throwIfAborted();
      const lease = await acquireLease(db, worldId);
      if (!lease) throw new Error('자기 migration 리스가 필요합니다.');
      try {
        await checked(async () => new TurnLoop(db, lease).advanceTo(0, signal));
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await releaseLease(db, lease);
        } catch (error) {
          failures.push(error);
        }
      }
    } catch (error) {
      failures.push(error);
    }
    for (const result of await settled) if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, 'migration 사람 생성 정착 실패');
    expect(await request).toBe(200);
    const general = await checked(async () =>
      db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: user.id } } }),
    );
    expect(await checked(async () => db.generalTurn.count({ where: { worldId, generalId: general.id } }))).toBe(30);
    await checked(async () => controlClock(db, worldId, 'pause'));
  }
  await checked(async () =>
    db.auditLog.create({
      data: {
        actorKind: 'ADMIN',
        actorUserId: ownerId,
        action: 'migration.fixture',
        targetType: 'World',
        targetId: worlds[0]!,
        payload: { kept: true },
      },
    }),
  );
  beforeTables = await checked(async () => tables());
  beforeHash = await checked(async () => rowsHash(beforeTables));
  beforeSequences = await checked(async () => sequences());
});
it('AC-M3-04 새 생성 요청 migration은 기존 모든 표·값·sequence를 그대로 보존한다', async (signal) => {
  signal.throwIfAborted();
  const path = new URL('../packages/db/prisma/migrations/' + migration + '/migration.sql', import.meta.url);
  await gate.query(await readFile(path, 'utf8'));
  expect((await tables()).filter((table) => !beforeTables.includes(table))).toEqual(['WorldCreateRequest']);
  expect(await rowsHash(beforeTables)).toBe(beforeHash);
  expect(await sequences()).toEqual(beforeSequences);
  expect((await gate.query('SELECT * FROM "WorldCreateRequest"')).rows).toEqual([]);
});
async function transaction(work: () => Promise<void>) {
  operationSignals.getStore()?.throwIfAborted();
  await gate.query('BEGIN');
  const failures: unknown[] = [];
  try {
    await checked(work);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await gate.query('ROLLBACK');
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'migration 음성·rollback 실패');
}
const insert = (values: Record<string, unknown> = {}) => {
  const row = {
    id: randomUUID(),
    requestedBy: ownerId,
    idempotencyKey: randomUUID(),
    intentHash: 'a'.repeat(64),
    intent: { version: 1 },
    effectiveSeed: 'migration-seed',
    plannedWorldId: randomUUID(),
    ...values,
  };
  return gate
    .query(
      'INSERT INTO "WorldCreateRequest" ("id","requestedBy","idempotencyKey","intentHash","intent","effectiveSeed","plannedWorldId") VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [
        row.id,
        row.requestedBy,
        row.idempotencyKey,
        row.intentHash,
        JSON.stringify(row.intent),
        row.effectiveSeed,
        row.plannedWorldId,
      ],
    )
    .then(() => row);
};
async function rejected(sql: string, values: unknown[] = [], code?: string) {
  operationSignals.getStore()?.throwIfAborted();
  let found: unknown;
  try {
    await checked(() => gate.query(sql, values));
  } catch (error) {
    operationSignals.getStore()?.throwIfAborted();
    found = error;
  }
  expect(found !== undefined, 'SQL 불가능 조합 거부').toBe(true);
  if (code)
    expect(typeof found === 'object' && found !== null && 'code' in found && found.code === code, '정확 SQLSTATE').toBe(
      true,
    );
}
for (const field of [
  'id',
  'requestedBy',
  'idempotencyKey',
  'version',
  'intentHash',
  'intent',
  'effectiveSeed',
  'plannedWorldId',
  'createdAt',
])
  it('AC-M3-04 생성 요청의 ' + field + '는 SQL에서도 불변이다', async () => {
    await transaction(async () => {
      const row = await insert();
      const value =
        field === 'version'
          ? 2
          : field === 'intent'
            ? JSON.stringify({ changed: true })
            : field === 'createdAt'
              ? new Date(0)
              : field === 'intentHash'
                ? 'b'.repeat(64)
                : randomUUID();
      await rejected('UPDATE "WorldCreateRequest" SET "' + field + '"=$1 WHERE id=$2', [value, row.id], '55000');
    });
  });
for (const [column, value] of [
  ['status', 'DONE'],
  ['status', 'FAILED'],
  ['worldId', randomUUID()],
  ['processedAt', new Date()],
  ['errorCode', 'RESOURCE_INVALID'],
] as const)
  it('AC-M3-04 PENDING의 잘못된 ' + column + ' null 조합을 거부한다', async () => {
    await transaction(async () => {
      const row = await insert();
      await rejected('UPDATE "WorldCreateRequest" SET "' + column + '"=$1 WHERE id=$2', [value, row.id]);
    });
  });
it('AC-M3-04 요청자·예정월드·결과월드 FK와 actor/key·plannedId 고유 제약을 지킨다', async () => {
  for (const mode of ['actor-fk', 'key-unique', 'planned-unique', 'world-fk'] as const)
    await transaction(async () => {
      const row = await insert();
      await gate.query('SAVEPOINT negative');
      if (mode === 'actor-fk')
        await rejected(
          'INSERT INTO "WorldCreateRequest" ("id","requestedBy","idempotencyKey","intentHash","intent","effectiveSeed","plannedWorldId") VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), '{}', 'seed', randomUUID()],
          '23503',
        );
      if (mode === 'key-unique')
        await rejected(
          'INSERT INTO "WorldCreateRequest" SELECT $1,"requestedBy","idempotencyKey",version,"intentHash",intent,"effectiveSeed",$2,NULL,status,NULL,NULL,"createdAt",NULL FROM "WorldCreateRequest" WHERE id=$3',
          [randomUUID(), randomUUID(), row.id],
          '23505',
        );
      if (mode === 'planned-unique')
        await rejected(
          'INSERT INTO "WorldCreateRequest" SELECT $1,"requestedBy",$2,version,"intentHash",intent,"effectiveSeed","plannedWorldId",NULL,status,NULL,NULL,"createdAt",NULL FROM "WorldCreateRequest" WHERE id=$3',
          [randomUUID(), randomUUID(), row.id],
          '23505',
        );
      if (mode === 'world-fk') {
        await gate.query('UPDATE "WorldCreateRequest" SET resolution=$1 WHERE id=$2', ['{}', row.id]);
        await rejected(
          'UPDATE "WorldCreateRequest" SET status=$1,"worldId"="plannedWorldId","processedAt"=CURRENT_TIMESTAMP WHERE id=$2',
          ['DONE', row.id],
          '23503',
        );
      }
    });
});
it('AC-M3-04 고정 resolution과 DONE·FAILED terminal 행을 다시 바꾸지 못한다', async () => {
  for (const mode of ['resolution', 'DONE', 'FAILED'] as const)
    await transaction(async () => {
      const row = await insert(mode === 'DONE' ? { plannedWorldId: worlds[0] } : {});
      if (mode === 'resolution') {
        await gate.query('UPDATE "WorldCreateRequest" SET resolution=$1 WHERE id=$2', ['{}', row.id]);
        await rejected(
          'UPDATE "WorldCreateRequest" SET resolution=$1 WHERE id=$2',
          ['{"changed":true}', row.id],
          '55000',
        );
      } else {
        await gate.query(
          'UPDATE "WorldCreateRequest" SET resolution=$1,status=$2,"worldId"=$3,"errorCode"=$4,"processedAt"=CURRENT_TIMESTAMP WHERE id=$5',
          ['{}', mode, mode === 'DONE' ? worlds[0] : null, mode === 'FAILED' ? 'RESOURCE_INVALID' : null, row.id],
        );
        await rejected(
          'UPDATE "WorldCreateRequest" SET status=$1,"worldId"=NULL,"errorCode"=NULL,"processedAt"=NULL WHERE id=$2',
          ['PENDING', row.id],
          '55000',
        );
      }
    });
});
it('AC-M3-04 결과 월드·행위자 삭제는 NO ACTION이며 기존 모든 행은 유지된다', async () => {
  await transaction(async () => {
    const row = await insert({ plannedWorldId: worlds[0] });
    await gate.query(
      'UPDATE "WorldCreateRequest" SET resolution=$1,status=$2,"worldId"=$3,"processedAt"=CURRENT_TIMESTAMP WHERE id=$4',
      ['{}', 'DONE', worlds[0], row.id],
    );
    await rejected('DELETE FROM "World" WHERE id=$1', [worlds[0]], '23503');
  });
  await transaction(async () => {
    await insert();
    await rejected('DELETE FROM "User" WHERE id=$1', [ownerId], '23503');
  });
  expect(await rowsHash(beforeTables)).toBe(beforeHash);
  expect((await gate.query('SELECT * FROM "WorldCreateRequest"')).rows).toEqual([]);
});
afterAll(
  () =>
    suite.hook('cleanup', async (signal) => {
      const deadline = Date.now() + 110_000;
      // Late setup/body/close success never clears suite.failed or authorizes DROP.
      await cleanupAttempt(settle, 70_000, false);

      const closers: Array<() => Promise<unknown>> = [
        async () => app?.close(),
        () => gate.end(),
        () => db.$disconnect(),
      ];
      await Promise.all(closers.map((close) => cleanupAttempt(close)));
      if (pending.size) suite.fail(new Error('미정착 원 작업이 있어 DB 보존'));
      for (const secret of secrets)
        if (secret && logs.join('\n').includes(secret)) suite.fail(new Error('종료 로그의 비공개 값 노출'));
      const mayDrop = () => {
        if (suite.failed || errors.length || pending.size || signal.aborted) return false;
        if (Date.now() + 30_000 >= deadline) {
          suite.fail(new Error('DROP 전 독립 정리 예산 부족: DB 보존'));
          return false;
        }
        return true;
      };
      let connections: number | undefined,
        dropped = false;
      try {
        if (oid) {
          signal.throwIfAborted();
          ({ connections } = await checked(() => confirmDisconnectedDatabase(admin, name, oid!), signal));
          if (mayDrop()) {
            await checked(() => admin.query('DROP DATABASE "' + name + '"'), signal);
            expect(
              (await checked(() => admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name]), signal)).rows,
            ).toHaveLength(0);
            dropped = true;
          }
        }
      } catch (error) {
        suite.fail(error);
      }

      const adminClosed = await cleanupAttempt(() => admin.end());
      console.info(
        JSON.stringify({
          event: 'admin-create-migration-cleanup',
          name,
          oid,
          connections,
          dropped,
          adminClosed,
          suiteFailed: suite.failed,
          hookAborted: signal.aborted,
          pendingOperations: pending.size,

          errors: errors.length,
        }),
      );
      if (errors.length) throw new AggregateError([...new Set(errors)], 'migration 본문·자기 자원 정리 실패');
    }),
  120_000,
);

it('AC-M3-04 새 FK는 NO ACTION이고 세 unique index가 정확히 존재한다', async () => {
  const foreign = (
    await gate.query(
      "SELECT confdeltype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1) AND contype='f' ORDER BY conname",
      ['"WorldCreateRequest"'],
    )
  ).rows;
  expect(foreign).toHaveLength(2);
  expect(
    foreign.every((row) => row.confdeltype === 'a'),
    '명시 NO ACTION',
  ).toBe(true);
  expect(foreign.map((row) => String(row.definition)).some((value) => value.includes('REFERENCES "User"'))).toBe(true);
  expect(foreign.map((row) => String(row.definition)).some((value) => value.includes('REFERENCES "World"'))).toBe(true);
  const indexes = (
    await gate.query(
      "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='WorldCreateRequest' ORDER BY indexname",
    )
  ).rows;
  for (const index of [
    'WorldCreateRequest_requestedBy_idempotencyKey_key',
    'WorldCreateRequest_plannedWorldId_key',
    'WorldCreateRequest_worldId_key',
  ]) {
    const found = indexes.find((row) => row.indexname === index);
    expect(found !== undefined && String(found.indexdef).includes('UNIQUE'), '정확 고유 index').toBe(true);
  }
  expect(await rowsHash(beforeTables)).toBe(beforeHash);
});
it('AC-M3-04 FAILED의 미지원 코드와 DONE의 다른 예정월드는 SQL에서 거부한다', async () => {
  for (const mode of ['FAILED', 'DONE'] as const)
    await transaction(async () => {
      const row = await insert({ plannedWorldId: worlds[0] });
      if (mode === 'FAILED')
        await rejected(
          'UPDATE "WorldCreateRequest" SET status=$1,"errorCode"=$2,"processedAt"=CURRENT_TIMESTAMP WHERE id=$3',
          ['FAILED', 'UNKNOWN_PRIVATE_ERROR', row.id],
          '23514',
        );
      else
        await rejected(
          'UPDATE "WorldCreateRequest" SET status=$1,resolution=$2,"worldId"=$3,"processedAt"=CURRENT_TIMESTAMP WHERE id=$4',
          ['DONE', '{}', worlds[1], row.id],
          '23514',
        );
    });
});

for (const hook of ['setup', 'cleanup'])
  it('AC-M3-04 ' + hook + ' 기한 뒤 원 작업이 성공해도 실패 DB 보존은 영구적이다', async () => {
    const localErrors: unknown[] = [],
      guard = suiteGuard((error) => localErrors.push(error));
    let resolve!: () => void;
    const late = new Promise<void>((done) => {
      resolve = done;
    });
    await expect(
      guard.hook(
        hook,
        () => late,
        (work) => Promise.resolve().then(work),
        5,
      ),
    ).rejects.toThrow('DB 보존');
    resolve();
    await late;
    await Promise.resolve();
    expect(guard.failed).toBe(true);
    expect(localErrors.length).toBeGreaterThan(0);
    let drops = 0;
    if (!guard.failed) drops++;
    expect(drops).toBe(0);
  });
