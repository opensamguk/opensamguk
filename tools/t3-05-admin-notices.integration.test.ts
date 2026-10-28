import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { testDatabaseUrl } from './test-database';
import { initializeResources } from './init-resources';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { publishNotice } from './notice-publish';

type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Pg;
};
if (!process.env.TEST_DATABASE_URL) throw new Error('전용 테스트 DB가 필요합니다.');
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('loopback 시험 서버가 필요합니다.');
for (const key of source.searchParams.keys())
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    throw new Error('접속 대상 질의 인자는 쓸 수 없습니다.');
const name = `t305_notice_${randomUUID().replaceAll('-', '')}_test`;
const legacyId = randomUUID();
const adminUrl = new URL(source),
  target = new URL(source);
adminUrl.pathname = '/postgres';
target.pathname = '/' + name;
const admin = new Client({ connectionString: adminUrl.href }),
  client = new Client({ connectionString: target.href });
const db = createDb(target.href),
  now = Date.now(),
  origin = 'http://127.0.0.1:5173';
const executions = new Set<Promise<unknown>>(),
  errors: unknown[] = [],
  logs: string[] = [],
  sensitive = new Set<string>();
let app: Awaited<ReturnType<typeof buildServer>> | undefined,
  address: string,
  created = false,
  oid: unknown;
let beforeCatalog: Record<string, unknown>[] = [],
  passwordHash: string;
function track<T>(action: () => Promise<T>) {
  const promise = Promise.resolve().then(action);
  executions.add(promise);
  void promise.then(
    () => executions.delete(promise),
    (error) => {
      errors.push(error);
      executions.delete(promise);
    },
  );
  return promise;
}
function it(title: string, action: () => Promise<void>) {
  test(title, () => track(action));
}
async function settle() {
  while (executions.size) await Promise.allSettled([...executions]);
}
const catalog = async () =>
  (await admin.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows;
beforeEach(settle);
async function user(
  role: 'USER' | 'ADMIN' = 'USER',
  status: 'ACTIVE' | 'SANCTIONED' | 'WITHDRAWN' = 'ACTIVE',
  verified = true,
  email = `${randomUUID()}@example.test`,
) {
  sensitive.add(email);
  return db.user.create({
    data: { email, passwordHash, role, status, emailVerifiedAt: verified ? new Date(now) : null },
  });
}
async function session(userId: string) {
  const value = newSession(now);
  sensitive.add(value.token);
  await db.session.create({ data: { id: value.id, userId, expiresAt: value.expiresAt } });
  return `sid=${value.token}`;
}
function call(path: string, input: unknown, cookie?: string) {
  return track(() => request(path, input, cookie));
}
async function together<T>(promises: Promise<T>[]) {
  const results = await Promise.allSettled(promises);
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      '동시 HTTP 요청 실패',
    );
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}
async function rollback() {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    errors.push(error);
  }
}
async function request(path: string, input: unknown, cookie?: string) {
  const mutation = [
    'admin.notice.create',
    'admin.notice.update',
    'admin.notice.hide',
    'general.create',
    'legal.agree',
  ].includes(path);
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${address}/trpc/${path}?batch=1${mutation ? '' : '&input=' + encodeURIComponent(encoded)}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const raw = await response.text();
  const [body] = JSON.parse(raw) as Array<{
    result?: { data: unknown };
    error?: { data: { code: string; reason: string | null } };
  }>;
  return {
    status: response.status,
    data: body!.result?.data,
    code: body!.error?.data.code,
    reason: body!.error?.data.reason,
    raw,
  };
}
async function gameSnapshot() {
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('AuditLog','User','Session','Sanction','Notice','AdminNoticeRequest') ORDER BY tablename`;
  const hash = createHash('sha256');
  for (const { tablename } of tables) {
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const rows = await db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t`,
    );
    hash.update(tablename + '\n' + rows[0]!.body + '\n');
  }
  return hash.digest('hex');
}
beforeAll(() =>
  track(async () => {
    await admin.connect();
    beforeCatalog = await catalog();
    expect(beforeCatalog.some((row) => row.datname === name)).toBe(false);
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    oid = (await catalog()).find((row) => row.datname === name)?.oid;
    expect(typeof oid).toBe('string');
    await client.connect();
    const root = new URL('../packages/db/prisma/migrations/', import.meta.url);
    for (const migration of (await readdir(root)).filter((value) => /^\d{14}_/.test(value)).sort()) {
      if (migration === '20261105000000_admin_notices')
        await client.query('INSERT INTO "Notice" (id,scope,title,body) VALUES ($1,\'LOBBY\',$2,$3)', [
          legacyId,
          '이전 공지',
          '이전 본문',
        ]);
      await client.query(await readFile(new URL(migration + '/migration.sql', root), 'utf8'));
    }
    expect(await db.notice.findUniqueOrThrow({ where: { id: legacyId } })).toMatchObject({
      title: '이전 공지',
      body: '이전 본문',
      revision: 0,
      hiddenAt: null,
    });
    await initializeResources(
      db,
      await readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
    );
    passwordHash = await hashPassword(randomUUID());
    sensitive.add(passwordHash);
    app = await buildServer({
      db,
      now: () => now,
      publicOrigin: origin,
      emailVerificationRequired: true,
      logStream: {
        write(chunk: string) {
          logs.push(chunk);
        },
      },
    });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  }),
);
afterAll(async () => {
  await settle();
  for (const close of [() => app?.close(), () => client.end(), () => db.$disconnect()]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  let connections: number | null = null,
    dropped = false;
  try {
    if (created) {
      expect((await catalog()).find((row) => row.datname === name)).toEqual({ datname: name, oid });
      for (let i = 0; i <= 20; i++) {
        connections = Number(
          (await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]!
            .count,
        );
        if (!connections || i === 20) break;
        await delay(50);
      }
      expect(connections).toBe(0);
      expect((await catalog()).find((row) => row.datname === name)).toEqual({ datname: name, oid });
      if (!errors.length) {
        await admin.query(`DROP DATABASE "${name}"`);
        dropped = true;
        expect(await catalog()).toEqual(beforeCatalog);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await admin.end();
  } catch (error) {
    errors.push(error);
  }
  console.info(
    JSON.stringify({ event: 't305-notice-cleanup', name, oid, connections, dropped, errors: errors.length }),
  );
  if (errors.length) throw new AggregateError([...new Set(errors)], '관리자 공지 실행·정리 실패');
});

type Result = { id: string; revision: number; hidden: boolean };
type Page = {
  items: Array<{
    id: string;
    title: string | null;
    body: string;
    revision: number;
    hiddenAt: string | null;
    pinned: boolean;
  }>;
  next: { at: string; id: string } | null;
};
const createInput = () => ({ scope: 'LOBBY', title: '공지 검사', body: '공지 본문', idempotencyKey: randomUUID() });
async function footprint() {
  const tables = [
    await db.notice.findMany({ orderBy: { id: 'asc' } }),
    await db.adminNoticeRequest.findMany({ orderBy: [{ actorUserId: 'asc' }, { idempotencyKey: 'asc' }] }),
    await db.auditLog.findMany({ orderBy: { id: 'asc' } }),
  ];
  return createHash('sha256')
    .update(JSON.stringify(tables, (_, value) => (typeof value === 'bigint' ? String(value) : value)))
    .digest('hex');
}
for (const path of ['admin.notice.list', 'admin.notice.create', 'admin.notice.update', 'admin.notice.hide'])
  for (const category of categories)
    it(
      `${path} ${category}`,
      authzCase(path, category, async () => {
        const adminUser = await user(
          category === 'otherUser' ? 'USER' : 'ADMIN',
          category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE',
        );
        const cookie = category === 'unauthenticated' ? undefined : await session(adminUser.id);
        const notice = await db.notice.create({ data: { scope: 'LOBBY', title: '원래 제목', body: '원래 본문' } });
        const value = path.endsWith('list')
          ? { scope: 'LOBBY' }
          : path.endsWith('create')
            ? createInput()
            : {
                id: notice.id,
                expectedRevision: 0,
                idempotencyKey: randomUUID(),
                ...(path.endsWith('hide') ? { reason: '숨김 검사' } : { title: '새 제목', body: '새 본문' }),
              };
        const before = await footprint(),
          game = await gameSnapshot();
        const result = await call(
          path,
          category === 'invalidInput' ? { ...value, actorUserId: adminUser.id } : value,
          cookie,
        );
        if (category === 'success') expect(result.status).toBe(200);
        else {
          expect(result.code).toBe(
            category === 'invalidInput' ? 'BAD_REQUEST' : category === 'otherUser' ? 'FORBIDDEN' : 'UNAUTHORIZED',
          );
          expect(result.reason).toBe(null);
          expect(await footprint()).toBe(before);
        }
        expect(await gameSnapshot()).toBe(game);
      }),
    );

it('작성·수정·숨김과 동일 재시도는 공지·요청·감사를 한 번씩만 반영한다', async () => {
  const adminUser = await user('ADMIN'),
    cookie = await session(adminUser.id),
    input = createInput();
  const count = await db.notice.count();
  const response = await call('admin.notice.create', input, cookie);
  expect(response.status).toBe(200);
  const result = response.data as Result;
  expect(result).toEqual({ id: expect.any(String), revision: 0, hidden: false });
  expect((await call('admin.notice.create', { ...input, title: '  공지 검사  ' }, cookie)).data).toEqual(result);
  expect(await db.notice.count()).toBe(count + 1);
  expect((await call('admin.notice.create', { ...input, body: '다른 본문' }, cookie)).code).toBe('CONFLICT');
  const update = {
    id: result.id,
    expectedRevision: 0,
    title: '<script>제목</script>',
    body: '여러 줄\n새 본문',
    idempotencyKey: randomUUID(),
  };
  const updated = await call('admin.notice.update', update, cookie);
  expect(updated.data).toEqual({ ...result, revision: 1 });
  expect((await call('admin.notice.update', update, cookie)).data).toEqual(updated.data);
  expect((await call('admin.notice.update', { ...update, idempotencyKey: randomUUID() }, cookie)).code).toBe(
    'CONFLICT',
  );
  const hide = { id: result.id, expectedRevision: 1, reason: '기간 종료', idempotencyKey: randomUUID() };
  const hidden = await call('admin.notice.hide', hide, cookie);
  expect(hidden.data).toEqual({ ...result, revision: 2, hidden: true });
  expect((await call('admin.notice.hide', hide, cookie)).data).toEqual(hidden.data);
  expect(
    (await call('admin.notice.update', { ...update, expectedRevision: 2, idempotencyKey: randomUUID() }, cookie)).code,
  ).toBe('CONFLICT');
  expect(await db.adminNoticeRequest.count({ where: { actorUserId: adminUser.id } })).toBe(3);
  const rows = await db.auditLog.findMany({ where: { actorUserId: adminUser.id }, orderBy: { id: 'asc' } });
  expect(rows.map((row) => row.action)).toEqual(['notice.create', 'notice.update', 'notice.hide']);
  expect(rows.map((row) => row.payload)).toEqual([
    { before: null, after: { revision: 0, hidden: false }, requestId: input.idempotencyKey },
    { before: { revision: 0, hidden: false }, after: { revision: 1, hidden: false }, requestId: update.idempotencyKey },
    { before: { revision: 1, hidden: false }, after: { revision: 2, hidden: true }, requestId: hide.idempotencyKey },
  ]);
  expect(rows.map((row) => row.reason)).toEqual([null, null, '기간 종료']);
  expect((await db.notice.findUniqueOrThrow({ where: { id: result.id } })).body).toBe(update.body);
  expect(
    ((await call('lobby.notices', undefined)).data as Array<{ id: string }>).some((row) => row.id === result.id),
  ).toBe(false);
  const listed = (await call('admin.notice.list', { scope: 'LOBBY' }, cookie)).data as Page;
  expect(listed.items.find((row) => row.id === result.id)).toMatchObject({
    revision: 2,
    hiddenAt: expect.any(String),
    body: update.body,
  });
});

it('동일 키 동시 작성과 두 관리자 동시 수정은 각각 한 번만 반영한다', async () => {
  const actor1 = await user('ADMIN'),
    actor2 = await user('ADMIN'),
    sid1 = await session(actor1.id),
    sid2 = await session(actor2.id);
  const input = createInput(),
    count = await db.notice.count();
  const results = await together([call('admin.notice.create', input, sid1), call('admin.notice.create', input, sid1)]);
  expect(results.map((row) => row.status)).toEqual([200, 200]);
  expect(results[0]!.data).toEqual(results[1]!.data);
  expect(await db.notice.count()).toBe(count + 1);
  const id = (results[0]!.data as Result).id;
  const changed = await together(
    [sid1, sid2].map((cookie, index) =>
      call(
        'admin.notice.update',
        {
          id,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
          title: '동시 수정',
          body: '수정 ' + index,
        },
        cookie,
      ),
    ),
  );
  expect(changed.map((row) => row.status).sort()).toEqual([200, 409]);
  expect((await db.notice.findUniqueOrThrow({ where: { id } })).revision).toBe(1);
  expect(await db.auditLog.count({ where: { targetId: id } })).toBe(2);
});

it('실제 감사 INSERT 거부는 세 변경의 공지·요청·감사를 함께 롤백한다', async () => {
  const adminUser = await user('ADMIN'),
    cookie = await session(adminUser.id);
  const notice = await db.notice.create({ data: { scope: 'LOBBY', title: '원문', body: '비공개 시험 원문' } });
  const before = await footprint(),
    game = await gameSnapshot();
  await client.query(
    `CREATE FUNCTION test_notice_deny() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'notice.%' THEN RAISE EXCEPTION 'private-notice-database-failure'; END IF; RETURN NEW; END $$`,
  );
  await client.query(
    'CREATE TRIGGER test_notice_deny BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION test_notice_deny()',
  );
  try {
    for (const [path, input] of [
      ['create', createInput()],
      [
        'update',
        { id: notice.id, expectedRevision: 0, idempotencyKey: randomUUID(), title: '새 제목', body: '민감 검사 본문' },
      ],
      ['hide', { id: notice.id, expectedRevision: 0, idempotencyKey: randomUUID(), reason: '숨김 검사' }],
    ] as const) {
      const result = await call('admin.notice.' + path, input, cookie);
      expect(result.code).toBe('INTERNAL_SERVER_ERROR');
      expect(result.raw.includes('private-notice-database-failure')).toBe(false);
      expect(result.raw.includes('민감 검사 본문')).toBe(false);
      expect(await footprint()).toBe(before);
    }
    expect(await gameSnapshot()).toBe(game);
  } finally {
    await client.query('DROP TRIGGER test_notice_deny ON "AuditLog"');
    await client.query('DROP FUNCTION test_notice_deny()');
  }
});

it('엄격 범위·길이·판과 없는 대상을 검증하고 미인증·회수·전체 제재를 거부한다', async () => {
  const adminUser = await user('ADMIN'),
    cookie = await session(adminUser.id),
    value = createInput();
  const unverified = await user('ADMIN', 'ACTIVE', false);
  expect((await call('admin.notice.create', value, await session(unverified.id))).reason).toBe('EMAIL_NOT_VERIFIED');
  for (const bad of [
    { ...value, scope: 'LOBBY', worldId: randomUUID() },
    { ...value, scope: 'WORLD' },
    { ...value, scope: 'WORLD', worldId: 'bad' },
    { ...value, title: ' ' },
    { ...value, title: '제'.repeat(201) },
    { ...value, body: ' ' },
    { ...value, body: '본'.repeat(2001) },
    { ...value, idempotencyKey: 'bad' },
  ])
    expect((await call('admin.notice.create', bad, cookie)).code).toBe('BAD_REQUEST');
  expect(
    (await call('admin.notice.create', { ...value, title: '제'.repeat(200), body: '본'.repeat(2000) }, cookie)).status,
  ).toBe(200);
  expect(
    (
      await call(
        'admin.notice.create',
        { ...value, scope: 'WORLD', worldId: randomUUID(), idempotencyKey: randomUUID() },
        cookie,
      )
    ).code,
  ).toBe('NOT_FOUND');
  for (const bad of [
    { scope: 'WORLD' },
    { scope: 'LOBBY', worldId: randomUUID() },
    { scope: 'LOBBY', cursor: { at: 'bad', id: randomUUID() } },
    { scope: 'LOBBY', extra: 1 },
  ])
    expect((await call('admin.notice.list', bad, cookie)).code).toBe('BAD_REQUEST');
  for (const expectedRevision of [-1, 2147483647, 0.5])
    expect(
      (
        await call(
          'admin.notice.hide',
          { id: randomUUID(), expectedRevision, idempotencyKey: randomUUID(), reason: '사유' },
          cookie,
        )
      ).code,
    ).toBe('BAD_REQUEST');
  for (const reason of [' ', '사'.repeat(201)])
    expect(
      (
        await call(
          'admin.notice.hide',
          { id: randomUUID(), expectedRevision: 0, idempotencyKey: randomUUID(), reason },
          cookie,
        )
      ).code,
    ).toBe('BAD_REQUEST');
  expect(
    (
      await call(
        'admin.notice.hide',
        { id: randomUUID(), expectedRevision: 0, idempotencyKey: randomUUID(), reason: '사유' },
        cookie,
      )
    ).code,
  ).toBe('NOT_FOUND');
  const before = await footprint();
  await db.user.update({ where: { id: adminUser.id }, data: { role: 'USER' } });
  expect((await call('admin.notice.create', value, cookie)).code).toBe('FORBIDDEN');
  await db.user.update({ where: { id: adminUser.id }, data: { role: 'ADMIN' } });
  await db.sanction.create({ data: { userId: adminUser.id, reason: '인증 검사', createdBy: adminUser.id } });
  expect((await call('admin.notice.create', value, cookie)).code).toBe('UNAUTHORIZED');
  expect(await footprint()).toBe(before);
});

it('로비 목록은 동률 시각에서도 50개 커서와 숨김 이력을 중복·누락 없이 분리한다', async () => {
  const cookie = await session((await user('ADMIN')).id),
    at = new Date(now - 10000);
  const ids: string[] = [];
  for (let i = 0; i < 103; i++) {
    const id = randomUUID();
    ids.push(id);
    await db.notice.create({
      data: { id, scope: 'LOBBY', title: '쪽 검사', body: '본문', publishedAt: at, hiddenAt: i % 3 ? null : at },
    });
  }
  const seen: string[] = [];
  let next: Page['next'] = null;
  do {
    const page = (await call('admin.notice.list', { scope: 'LOBBY', ...(next ? { cursor: next } : {}) }, cookie))
      .data as Page;
    expect(page.items.length).toBeLessThanOrEqual(50);
    seen.push(...page.items.map((row) => row.id));
    next = page.next;
  } while (next);
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.filter((id) => ids.includes(id))).toEqual(ids.sort().reverse());
});

const formalWorlds: string[] = [];
let worldCookie: string, worldActorCookie: string;
for (const index of [0, 1])
  it(`정식191년 ${index + 1}번째 월드·사람·30칸을 실제 엔진으로 준비한다`, async () => {
    let humanUserId: string;
    if (!index) {
      const human = await user();
      humanUserId = human.id;
      worldCookie = await session(human.id);
      worldActorCookie = await session((await user('ADMIN')).id);
    } else {
      const token = worldCookie.slice(4),
        id = createHash('sha256').update(token).digest('hex');
      humanUserId = (await db.session.findUniqueOrThrow({ where: { id } })).userId;
    }
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'admin-notice-formal',
    });
    initial.ruleFeatures = [
      'campaign-assignment-v2',
      'campaign-v1',
      'five-stats',
      'operational-map',
      'personnel',
      'policy',
      'stratagem-basic',
      'treaty',
    ];
    expect(initial.nations).toHaveLength(21);
    expect(initial.generals).toHaveLength(491);
    const { worldId } = await saveInitialWorld(db, initial, {
      name: `공지 확인 ${index + 1}`,
      turnTermMinutes: 60,
      endYear: 201,
    });
    formalWorlds.push(worldId);
    await controlClock(db, worldId, 'start');
    const pending = track(() =>
      call(
        'general.create',
        {
          worldId,
          name: '공지장수',
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
          portraitId: null,
        },
        worldCookie,
      ),
    );
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, userId: humanUserId, status: 'PENDING' } }))
      .toBe(1);
    const lease = await acquireLease(db, worldId);
    expect(lease).not.toBeNull();
    try {
      await new TurnLoop(db, lease!).advanceTo(0);
    } finally {
      await releaseLease(db, lease!);
    }
    expect((await pending).status).toBe(200);
    const human = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: humanUserId } } });
    expect(await db.general.count({ where: { worldId, userId: null } })).toBe(491);
    expect(await db.generalTurn.count({ where: { worldId, generalId: human.id } })).toBe(30);
  });

it('옛 CLI의 null 제목·고정 월드 공지를 보존하며 두 정식 월드에서 작성·수정·숨김을 격리한다', async () => {
  const before = await gameSnapshot(),
    worldId = formalWorlds[0]!,
    other = formalWorlds[1]!;
  const old = await publishNotice(db, { scope: 'world', worldId, body: '기존 고정 공지', pinned: true });
  const original = await db.notice.findUniqueOrThrow({ where: { id: old.id } });
  expect(original).toMatchObject({ title: null, pinned: true, hiddenAt: null, revision: 0 });
  const lobby = await publishNotice(db, { scope: 'lobby', title: '명령줄 로비', body: '기존 로비 본문' });
  expect(
    ((await call('lobby.notices', undefined)).data as Array<{ id: string }>).some((row) => row.id === lobby.id),
  ).toBe(true);
  const input = { ...createInput(), scope: 'WORLD', worldId };
  const created = (await call('admin.notice.create', input, worldActorCookie)).data as Result;
  const readWorld = async (id: string) =>
    (await call('notice.world.list', { worldId: id }, worldCookie)).data as {
      items: Array<{ id: string; body: string; pinned: boolean }>;
    };
  expect((await readWorld(worldId)).items.map((row) => row.id)).toEqual([old.id, created.id]);
  expect((await readWorld(other)).items).toEqual([]);
  expect(
    ((await call('admin.notice.list', { scope: 'WORLD', worldId: other }, worldActorCookie)).data as Page).items,
  ).toEqual([]);
  const edited = await call(
    'admin.notice.update',
    { id: old.id, expectedRevision: 0, title: '기존 제목 추가', body: '수정 본문', idempotencyKey: randomUUID() },
    worldActorCookie,
  );
  expect(edited.status).toBe(200);
  expect((await readWorld(worldId)).items[0]).toMatchObject({ id: old.id, pinned: true, body: '수정 본문' });
  expect(
    (
      await call(
        'admin.notice.hide',
        { id: old.id, expectedRevision: 1, reason: '종료', idempotencyKey: randomUUID() },
        worldActorCookie,
      )
    ).status,
  ).toBe(200);
  expect((await readWorld(worldId)).items.map((row) => row.id)).toEqual([created.id]);
  expect(await db.notice.count({ where: { id: old.id } })).toBe(1);
  expect(await gameSnapshot()).toBe(before);
});

for (const change of ['role', 'expiry', 'sanction', 'email'] as const)
  it(`잠금 뒤 ${change} 변경을 다시 읽어 진행 중 HTTP 쓰기를 거부한다`, async () => {
    const adminUser = await user('ADMIN'),
      cookie = await session(adminUser.id),
      before = await footprint();
    await client.query('BEGIN');
    try {
      if (change === 'email')
        await client.query('UPDATE "User" SET "emailVerifiedAt"=NULL WHERE id=$1', [adminUser.id]);
      else if (change === 'role') await client.query('UPDATE "User" SET role=\'USER\' WHERE id=$1', [adminUser.id]);
      else if (change === 'expiry')
        await client.query('UPDATE "Session" SET "expiresAt"=now()-interval \'1 minute\' WHERE "userId"=$1', [
          adminUser.id,
        ]);
      else {
        await client.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [adminUser.id]);
        await client.query('INSERT INTO "Sanction" (id,"userId",reason,"createdBy") VALUES ($1,$2,$3,$2)', [
          randomUUID(),
          adminUser.id,
          '경합 검사',
        ]);
      }
      const pending = track(() => call('admin.notice.create', createInput(), cookie));
      await expect
        .poll(async () =>
          Number(
            (
              await admin.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND (query LIKE '%FOR UPDATE%' OR query LIKE '%FOR SHARE%')",
                [name],
              )
            ).rows[0]!.n,
          ),
        )
        .toBe(1);
      await client.query('COMMIT');
      const result = await pending;
      expect(result.code).toBe(['role', 'email'].includes(change) ? 'FORBIDDEN' : 'UNAUTHORIZED');
      if (change === 'email') expect(result.reason).toBe('EMAIL_NOT_VERIFIED');
      expect(await footprint()).toBe(before);
    } finally {
      await rollback();
    }
  });

it('현재 동의가 필요하며 잠금 중 동의 회수도 성공한 요청의 재시도보다 먼저 검사한다', async () => {
  // trusted 테스트 생성자에만 판을 주입한다. 운영 approvedPolicy는 계속 null이다.
  const policy = {
    terms: { version: 'notice-test-terms', effectiveAt: '2026-01-01T00:00:00Z' },
    privacy: { version: 'notice-test-privacy', effectiveAt: '2026-01-01T00:00:00Z' },
  };
  const server = await buildServer({
    db,
    now: () => now,
    publicOrigin: origin,
    emailVerificationRequired: true,
    legalPolicy: policy,
    logging: false,
  });
  const previousAddress = address;
  try {
    address = await server.listen({ host: '127.0.0.1', port: 0 });
    const adminUser = await user('ADMIN'),
      cookie = await session(adminUser.id),
      input = createInput();
    expect((await call('admin.notice.create', input, cookie)).reason).toBe('CONSENT_REQUIRED');
    for (const docType of ['TERMS', 'PRIVACY'] as const)
      expect(
        (
          await call(
            'legal.agree',
            { docType, version: policy[docType === 'TERMS' ? 'terms' : 'privacy'].version },
            cookie,
          )
        ).status,
      ).toBe(200);
    expect((await call('admin.notice.create', input, cookie)).status).toBe(200);
    const before = await footprint();
    await client.query('BEGIN');
    try {
      await client.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [adminUser.id]);
      await client.query('DELETE FROM "ConsentRecord" WHERE "userId"=$1', [adminUser.id]);
      const pending = track(() => call('admin.notice.create', input, cookie));
      await expect
        .poll(async () =>
          Number(
            (
              await admin.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'",
                [name],
              )
            ).rows[0]!.n,
          ),
        )
        .toBe(1);
      await client.query('COMMIT');
      expect((await pending).reason).toBe('CONSENT_REQUIRED');
      expect(await footprint()).toBe(before);
    } finally {
      await rollback();
    }
  } finally {
    address = previousAddress;
    await server.close();
  }
});

it('관리자 변경도 실제 HTTP의 다른 Origin·CSRF 입력을 받지 않는다', async () => {
  const cookie = await session((await user('ADMIN')).id),
    before = await footprint();
  for (const headers of [{ origin: 'https://other.example.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await fetch(address + '/trpc/admin.notice.create?batch=1', {
      method: 'POST',
      headers: { ...headers, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ 0: createInput() }),
    });
    expect(response.status).toBe(403);
    await response.arrayBuffer();
  }
  expect(await footprint()).toBe(before);
  for (const value of sensitive) expect(logs.join('').includes(value), '비밀값과 개인정보 로그 비노출').toBe(false);
});
