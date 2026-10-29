import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { ruleRegistry } from '../packages/rules/src/index';
import { buildServer } from '../apps/server/src/server';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { creationFeatures } from '../apps/server/src/admin/worldCreateOptions';
import { integrationResourceRows } from './integration-resources';
import { verifyInitializedResources } from './init-resources';
import { validateWorldResources } from '../packages/rules/src/world/validate';
import { testDatabaseUrl } from './test-database';
import {
  auditOwnedCreate,
  CreateOptionsBoundary,
  type CreateOptionsPhase,
  type OwnedCreateAudit,
} from './admin-create-options-boundary';

if (!process.env.TEST_DATABASE_URL) throw new Error('전용 TEST_DATABASE_URL이 필요합니다.');
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('loopback 전용 시험 DB가 필요합니다.');
for (const key of source.searchParams.keys())
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    throw new Error('접속 대상 인자는 쓸 수 없습니다.');
const suffix = randomUUID().replaceAll('-', '');
const name = 't305_create_options_' + suffix + '_test',
  primaryApplicationName = 't305_create_options_admin_' + suffix;
const target = new URL(source),
  adminUrl = new URL(source);
target.pathname = '/' + name;
testDatabaseUrl({ TEST_DATABASE_URL: target.href, DATABASE_URL: process.env.DATABASE_URL });
adminUrl.pathname = '/postgres';
interface NativePg {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
const requireServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { Client } = requireServer('pg') as {
  Client: new (options: {
    connectionString: string;
    connectionTimeoutMillis: number;
    query_timeout: number;
    application_name: string;
  }) => NativePg;
};
const client = (connectionString: string, application_name: string) =>
  new Client({
    connectionString,
    application_name,
    connectionTimeoutMillis: 1500,
    query_timeout: 1500,
  });
const admin = client(adminUrl.href, primaryApplicationName),
  migration = client(target.href, 't305_options_migration_' + suffix);
const db = createDb(target.href),
  lifetime = new CreateOptionsBoundary(),
  origin = 'http://127.0.0.1:5173';
let app: Awaited<ReturnType<typeof buildServer>> | undefined,
  address = '',
  initialOid: string | undefined,
  passwordHash = '',
  baselineAbsent = false,
  createSent = false,
  setupSettled = false,
  cleanupSettled = false,
  serverConstructionSent = false;
let createOutcome: 'not-sent' | 'unknown' | 'confirmed' = 'not-sent',
  activeCase: CreateOptionsPhase | undefined;
const closed = { server: false, migration: false, db: false, admin: false, auditor: false };
const path = 'admin.world.creationOptions';
function bounded<T>(start: () => Promise<T>) {
  if (!activeCase) throw new Error('실행 중인 생성 설정 시험이 없습니다.');
  return activeCase.run(start);
}
async function actor(role: 'ADMIN' | 'USER' = 'ADMIN', status: 'ACTIVE' | 'SANCTIONED' = 'ACTIVE') {
  const session = newSession(Date.now());
  const user = await bounded(() =>
    db.user.create({
      data: {
        email: randomUUID() + '@example.test',
        role,
        status,
        passwordHash,
        emailVerifiedAt: new Date(),
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
    }),
  );
  return { id: user.id, cookie: 'sid=' + session.token };
}
async function call(input: unknown, cookie?: string) {
  if (!activeCase) throw new Error('실행 중인 생성 설정 시험이 없습니다.');
  const signal = activeCase.controller.signal;
  const response = await bounded(() =>
    fetch(address + '/trpc/' + path + '?input=' + encodeURIComponent(JSON.stringify(input)), {
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
      signal,
    }),
  );
  const body = (await bounded(() => response.json())) as { result?: { data?: unknown }; error?: unknown };
  return { status: response.status, body };
}
beforeAll(async () => {
  // 외부 hook30초보다 먼저 멈춘다. 원 Promise는 별도 집합에 계속 남긴다.
  const phase = lifetime.phase('setup', 22_000, true);
  const original = (async () => {
    await phase.run(() => admin.connect());
    const before = await phase.run(() => admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name]));
    baselineAbsent = before.rows.length === 0;
    if (!baselineAbsent) throw new Error('자기 시험 DB의 생성 전 부재를 확인하세요.');
    await phase.run(() => {
      createSent = true;
      createOutcome = 'unknown';
      return admin.query(`CREATE DATABASE "${name}"`);
    });
    createOutcome = 'confirmed';
    const identity = await phase.run(() =>
      admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name]),
    );
    const value = identity.rows.length === 1 ? identity.rows[0]!.oid : undefined;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('생성 OID를 확인하세요.');
    initialOid = value;
    await phase.run(() => migration.connect());
    const root = new URL('../packages/db/prisma/migrations/', import.meta.url);
    for (const directory of (await phase.run(() => readdir(root))).filter((entry) => /^\d{14}_/.test(entry)).sort()) {
      const sql = await phase.run(() => readFile(new URL(directory + '/migration.sql', root), 'utf8'));
      await phase.run(() => migration.query(sql));
    }
    const baseSql = await phase.run(() =>
      readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
    );
    await phase.run(() => migration.query(baseSql));
    const baseRows = await phase.run(() => db.gameResource.findMany());
    verifyInitializedResources(baseRows);
    const rows = await phase.run(() => integrationResourceRows());
    const manifest = JSON.parse(
      await phase.run(() => readFile(new URL('../resources/integration-manifest.json', import.meta.url), 'utf8')),
    );
    expect(
      rows.map(({ kind, name, version, contentHash, source }) => ({ kind, name, version, contentHash, source })),
    ).toEqual(manifest);
    const content = Object.fromEntries(rows.map((row) => [row.kind, row.content]));
    const unitSet = baseRows.find((row) => row.kind === 'UNIT_SET' && row.name === 'basic' && row.version === 1);
    expect(
      validateWorldResources({
        map: content.MAP,
        scenario: content.SCENARIO,
        unitSet: unitSet?.content,
        statRules: content.STAT_RULES,
        portraitMap: content.PORTRAIT_MAP,
      }).status,
    ).toBe('pass');
    await phase.run(() =>
      db.gameResource.createMany({
        data: rows.map(({ kind, name, version, content, contentHash, source }) => ({
          kind,
          name,
          version,
          content,
          contentHash,
          source,
          status: 'PUBLISHED' as const,
          publishedAt: new Date(),
        })),
      }),
    );
    passwordHash = await phase.run(() => hashPassword(randomUUID()));
    await phase.run(async () => {
      serverConstructionSent = true;
      app = await buildServer({ db, publicOrigin: origin, emailVerificationRequired: true, logging: false });
    });
    address = await phase.run(() => app!.listen({ host: '127.0.0.1', port: 0 }));
  })();
  void original.then(
    () => {
      setupSettled = true;
    },
    () => {
      setupSettled = true;
    },
  );
  try {
    await phase.guard(original);
  } catch {
    lifetime.fail('setup-failed', true);
    throw new Error('생성 설정 시험 준비에 실패했습니다.');
  } finally {
    lifetime.finish(phase);
  }
});
beforeEach(({ signal, onTestFailed }) => {
  activeCase = lifetime.phase('case', 25_000, true, signal);
  onTestFailed(() => {
    lifetime.fail('vitest-test-failed', true);
  });
});
afterEach(({ task }) => {
  if (task.result?.state === 'fail') lifetime.fail('vitest-test-failed', true);
  if (activeCase) lifetime.finish(activeCase);
  activeCase = undefined;
});
// Vitest5의 suite는 두 번째 인자이며 첫 fixture 인자는 빈 구조 분해여야 한다.
// eslint-disable-next-line no-empty-pattern
afterAll(async ({}, suite) => {
  // Vitest5의 suite hook에는 TestContext.signal이 없다. 실제 hook 실패 결과도 읽어 중단을 고정한다.
  lifetime.observeHooks(suite.result);
  if (!setupSettled) lifetime.fail('setup-flow-still-running', true);
  lifetime.sealWork();
  const cleanupDeadline = Date.now() + 12_000;
  const drain = lifetime.phase('drain-original', 3000);
  const originals = [...lifetime.pending, ...lifetime.flows];
  try {
    if (originals.length) await drain.run(() => Promise.allSettled(originals));
  } catch {
    lifetime.fail('original-work-unsettled', true);
  } finally {
    lifetime.finish(drain);
  }
  const cleanup = lifetime.phase('cleanup', Math.max(1, cleanupDeadline - Date.now()));
  const closeActions = [
    async () => {
      if (app) {
        await app.close();
        closed.server = true;
      } else closed.server = !serverConstructionSent;
    },
    async () => {
      await migration.end();
      closed.migration = true;
    },
    async () => {
      await db.$disconnect();
      closed.db = true;
    },
    async () => {
      await admin.end();
      closed.admin = true;
    },
  ];
  const originalCleanup = Promise.allSettled(closeActions.map((close) => cleanup.run(close)));
  void originalCleanup.then(() => {
    cleanupSettled = true;
  });
  try {
    await cleanup.guard(originalCleanup);
  } catch {
    lifetime.fail('cleanup-deadline', true);
  } finally {
    lifetime.finish(cleanup);
  }
  const auditor = client(adminUrl.href, 't305_options_audit_' + suffix);
  const audit: OwnedCreateAudit = { attempted: false, complete: false, identityKnown: false, dropOutcome: 'not-sent' };
  const auditPhase = lifetime.phase('independent-audit', 8000);
  try {
    const originalAudit = (async () => {
      await auditPhase.run(() => auditor.connect());
      await auditOwnedCreate(
        lifetime,
        auditPhase,
        {
          name,
          baselineAbsent,
          createSent,
          createOutcome,
          ...(initialOid === undefined ? {} : { initialOid }),
          primaryApplicationName,
          workSettled: setupSettled && cleanupSettled && lifetime.pending.size === 0,
          clientsClosed: closed.server && closed.migration && closed.db && closed.admin,
        },
        (sql, values) => auditor.query(sql, values),
        audit,
      );
    })();
    await auditPhase.guard(originalAudit);
  } catch {
    lifetime.fail('final-own-audit-incomplete', true);
  } finally {
    lifetime.finish(auditPhase);
  }
  // 실패해도 별도3초의 실제 감사 연결 종료와2초의 최종 원장을 남길 여유를 둔다.
  const closePhase = lifetime.phase('audit-admin-close', 3000);
  try {
    await closePhase.run(async () => {
      await auditor.end();
      closed.auditor = true;
    });
  } catch {
    lifetime.fail('audit-admin-close-incomplete', true);
  } finally {
    lifetime.finish(closePhase);
  }
  const receipt = lifetime.phase('final-receipt', 2000);
  try {
    await receipt.run(() => mkdir(new URL('../test-results/', import.meta.url), { recursive: true }));
    const finalObservations = {
      name,
      baselineAbsent,
      createSent,
      createOutcome,
      initialOid,
      setupSettled,
      cleanupSettled,
      closed,
      audit,
      failed: lifetime.failed,
      uncertain: lifetime.uncertain,
      reasons: [...lifetime.reasons],
      pending: lifetime.pending.size,
      flows: lifetime.flows.size,
      budgetsMs: { setup: 22000, cleanup: 12000, audit: 8000, finalClose: 3000, receipt: 2000, externalHook: 30000 },
      observationScope: 'All non-receipt work observed before starting this final file write',
    };
    await receipt.run(() =>
      writeFile(
        new URL('../test-results/admin-create-options-' + name + '.json', import.meta.url),
        JSON.stringify(finalObservations, null, 2),
      ),
    );
  } finally {
    lifetime.finish(receipt);
  }
  if (lifetime.failed || lifetime.uncertain || lifetime.pending.size || lifetime.flows.size)
    throw new Error('생성 설정 시험 또는 정리 실패입니다. 최종 원장과 보존한 자기 DB를 확인하세요.');
});
for (const category of categories)
  it(
    'AC-M3-04 생성 설정 실제 HTTP ' + category,
    authzCase(path, category, async () => {
      const owner = await actor(),
        other = await actor(),
        requester = category === 'sanctioned' ? await actor('ADMIN', 'SANCTIONED') : owner;
      const before = await bounded(() => db.world.count());
      const result = await call(
        category === 'invalidInput'
          ? { expectedUserId: owner.id, extra: true }
          : { expectedUserId: category === 'otherUser' ? other.id : requester.id },
        category === 'unauthenticated' ? undefined : requester.cookie,
      );
      expect(result.status).toBe(category === 'success' ? 200 : category === 'invalidInput' ? 400 : 401);
      if (category === 'success') {
        expect(result.body.result?.data).toMatchObject({ userId: owner.id });
        const data = result.body.result!.data as {
          profiles: Array<{ available: boolean; code?: string; ruleFeatures?: string[] }>;
        };
        const cityRegistered = ruleRegistry.features.some((feature) => feature.key === 'city-resources-v1');
        expect(data.profiles[0]!.available).toBe(cityRegistered);
        if (cityRegistered) expect(data.profiles[0]!.ruleFeatures).toEqual([...creationFeatures]);
        else expect(data.profiles[0]!.code).toBe('RULES_UNAVAILABLE');
        expect(JSON.stringify(data)).not.toMatch(/password|connectionString|portraitId|generalStats|DATABASE_URL/);
      }
      expect(await bounded(() => db.world.count())).toBe(before);
    }),
  );
it('AC-M3-04 역할 회수·일반회원은 같은 계정 UUID여도 생성 설정을 못 읽는다', async () => {
  const owner = await actor();
  expect((await call({ expectedUserId: owner.id }, owner.cookie)).status).toBe(200);
  await bounded(() => db.user.update({ where: { id: owner.id }, data: { role: 'USER' } }));
  expect((await call({ expectedUserId: owner.id }, owner.cookie)).status).toBe(403);
});
it('AC-M3-04 도시 규칙 통합 뒤 실제 게시 정식9기능을 검증한다', async () => {
  expect(ruleRegistry.features.some((feature) => feature.key === 'city-resources-v1')).toBe(true);
  const owner = await actor();
  const result = await call({ expectedUserId: owner.id }, owner.cookie);
  expect(result.body.result?.data).toMatchObject({
    profiles: [
      { available: true, ruleFeatures: [...creationFeatures], counts: { nations: 21, generals: 491, anchors: 61 } },
    ],
  });
});
