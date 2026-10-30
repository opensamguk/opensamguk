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
const name = `t305_read_${randomUUID().replaceAll('-', '')}_test`;
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
type SearchRow = {
  userId: string;
  email: string;
  status: string;
  role: string;
  createdAt: string;
  activeSanctions: number;
};
type AuditRow = {
  id: string;
  at: string;
  actorKind: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  worldId: string | null;
  reason: string | null;
  payload: unknown;
  inputEventId: string | null;
};
async function call(path: string, input: unknown, cookie?: string) {
  const response = await fetch(
    `${address}/trpc/${path}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`,
    {
      headers: { origin, ...(cookie ? { cookie } : {}) },
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
async function gameSnapshot(all = false) {
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' AND (${all} OR tablename NOT IN ('AuditLog','User','Session','Sanction')) ORDER BY tablename`;
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
    for (const migration of (await readdir(root)).filter((value) => /^\d{14}_/.test(value)).sort())
      await client.query(await readFile(new URL(migration + '/migration.sql', root), 'utf8'));
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
  console.info(JSON.stringify({ event: 't305-read-cleanup', name, oid, connections, dropped, errors: errors.length }));
  if (errors.length) throw new AggregateError([...new Set(errors)], '관리자 조회 실행·정리 실패');
});

for (const path of ['admin.user.search', 'admin.user.get', 'admin.audit.list'])
  for (const category of categories)
    it(
      `${path} ${category}`,
      authzCase(path, category, async () => {
        const actor = await user(
          category === 'otherUser' ? 'USER' : 'ADMIN',
          category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE',
        );
        const cookie = category === 'unauthenticated' ? undefined : await session(actor.id);
        const before = await db.auditLog.count(),
          game = await gameSnapshot();
        const input =
          category === 'invalidInput'
            ? { role: 'ADMIN' }
            : path === 'admin.user.search'
              ? { query: randomUUID() }
              : path === 'admin.user.get'
                ? { userId: actor.id }
                : {};
        const result = await call(path, input, cookie);
        if (category === 'success') expect(result.status).toBe(200);
        else {
          expect(result.code).toBe(
            category === 'invalidInput' ? 'BAD_REQUEST' : category === 'otherUser' ? 'FORBIDDEN' : 'UNAUTHORIZED',
          );
          expect(result.reason).toBe(null);
        }
        expect(await db.auditLog.count()).toBe(
          before + (category === 'success' && path !== 'admin.audit.list' ? 1 : 0),
        );
        expect(await gameSnapshot()).toBe(game);
      }),
    );

it('미인증·회수·비활성 관리자와 위조 입력은 조회·감사를 실행하지 않는다', async () => {
  const actor = await user('ADMIN', 'ACTIVE', false),
    revoked = await user('ADMIN'),
    inactive = await user('ADMIN', 'WITHDRAWN');
  const cookies = [await session(actor.id), await session(revoked.id), await session(inactive.id)];
  await db.user.update({ where: { id: revoked.id }, data: { role: 'USER' } });
  const before = await db.auditLog.count(),
    game = await gameSnapshot();
  for (const path of ['admin.user.search', 'admin.user.get', 'admin.audit.list']) {
    const input = path.endsWith('search')
      ? { query: randomUUID() }
      : path === 'admin.user.get'
        ? { userId: actor.id }
        : {};
    expect((await call(path, input, cookies[0])).reason).toBe('EMAIL_NOT_VERIFIED');
    expect((await call(path, input, cookies[1])).code).toBe('FORBIDDEN');
    expect((await call(path, input, cookies[2])).code).toBe('UNAUTHORIZED');
  }
  const valid = await session((await user('ADMIN')).id);
  for (const query of [
    '',
    'aa',
    'a'.repeat(255),
    'bad\nquery',
    { worldId: randomUUID(), generalName: ' ' },
    { worldId: randomUUID(), generalName: '가'.repeat(31) },
    { worldId: randomUUID(), generalName: '검사', userId: revoked.id },
  ])
    expect((await call('admin.user.search', { query }, valid)).code).toBe('BAD_REQUEST');
  for (const input of [
    { cursor: '0' },
    { cursor: '-1' },
    { cursor: '9223372036854775808' },
    { from: '2026-12-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
    { action: '%' },
    { action: 'user_search' },
    { from: 'no' },
    { actorUserId: 'no' },
    { targetId: ' ' },
    { worldId: 'no' },
    { userId: revoked.id },
  ])
    expect((await call('admin.audit.list', input, valid)).code).toBe('BAD_REQUEST');
  expect(await db.auditLog.count()).toBe(before);
  expect(await gameSnapshot()).toBe(game);
});

it('UUID·이메일 정규화·0결과·50상한·정렬과 현재 제재 개수만 반환한다', async () => {
  const actor = await user('ADMIN'),
    cookie = await session(actor.id),
    victim = await user();
  const special = `prefix%_\\${randomUUID()}`;
  const literal = await user('USER', 'ACTIVE', true, `${special}@example.test`);
  await user('USER', 'ACTIVE', true, special.replace('%_\\', 'XXX') + '@example.test');
  expect((await call('admin.user.search', { query: `  ${special.toUpperCase()}  ` }, cookie)).data).toEqual([
    {
      userId: literal.id,
      email: literal.email,
      status: 'ACTIVE',
      role: 'USER',
      createdAt: literal.createdAt.toISOString(),
      activeSanctions: 0,
    },
  ]);
  await db.sanction.createMany({
    data: [
      { userId: victim.id, createdBy: actor.id, reason: '현재' },
      { userId: victim.id, createdBy: actor.id, reason: '미래', expiresAt: new Date(now + 1) },
      { userId: victim.id, createdBy: actor.id, reason: '만료', expiresAt: new Date(now) },
      {
        userId: victim.id,
        createdBy: actor.id,
        reason: '해제',
        liftedAt: new Date(now),
        liftedBy: actor.id,
        liftReason: '시험 해제',
      },
    ],
  });
  const result = await call('admin.user.search', { query: victim.id }, cookie);
  expect(result.data).toEqual([
    {
      userId: victim.id,
      email: victim.email,
      status: 'ACTIVE',
      role: 'USER',
      createdAt: victim.createdAt.toISOString(),
      activeSanctions: 2,
    },
  ]);
  const prefix = `bulk-${randomUUID()}`;
  await db.user.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({
      email: `${prefix}-${i}@example.test`,
      passwordHash,
      createdAt: new Date(now),
    })),
  });
  const expected = await db.user.findMany({
    where: { email: { startsWith: prefix } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
    select: { id: true },
  });
  expect(
    ((await call('admin.user.search', { query: prefix }, cookie)).data as SearchRow[]).map((row) => row.userId),
  ).toEqual(expected.map((row) => row.id));
  expect((await call('admin.user.search', { query: randomUUID() }, cookie)).data).toEqual([]);
  const audits = await db.auditLog.findMany({ where: { actorUserId: actor.id }, orderBy: { id: 'asc' } });
  expect(audits.map((row) => row.payload)).toEqual([
    { queryKind: 'EMAIL_PREFIX', resultCount: 1 },
    { queryKind: 'USER_ID', resultCount: 1 },
    { queryKind: 'EMAIL_PREFIX', resultCount: 50 },
    { queryKind: 'USER_ID', resultCount: 0 },
  ]);
  for (const row of audits) {
    expect(row).toMatchObject({ targetType: 'User', targetId: null, worldId: null, reason: null, inputEventId: null });
    for (const value of [victim.id, victim.email, literal.id, literal.email, special, prefix])
      expect(
        JSON.stringify(row, (_, item) => (typeof item === 'bigint' ? item.toString() : item)).includes(value),
        '감사 개인정보 비노출',
      ).toBe(false);
  }
});

const formalWorlds: string[] = [];
let formalActor: Awaited<ReturnType<typeof user>>,
  formalVictim: Awaited<ReturnType<typeof user>>,
  formalCookie: string,
  victimCookie: string;
for (const index of [0, 1])
  it(`정식191년 ${index + 1}번째 월드·사람 장수를 실제 API와 엔진으로 준비한다`, async () => {
    if (index === 0) {
      formalActor = await user('ADMIN');
      formalVictim = await user();
      formalCookie = await session(formalActor.id);
      victimCookie = await session(formalVictim.id);
    }
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'admin-read-formal',
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
      name: `관리 조회 ${index + 1}`,
      turnTermMinutes: 60,
      endYear: 201,
    });
    formalWorlds.push(worldId);
    await controlClock(db, worldId, 'start');
    const pending = track(async () => {
      const response = await fetch(`${address}/trpc/general.create?batch=1`, {
        method: 'POST',
        headers: { origin, cookie: victimCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          0: {
            worldId,
            name: index ? '다른월드사람' : '조회사람',
            leadership: 55,
            strength: 55,
            intel: 55,
            politics: 55,
            charm: 55,
            portraitId: null,
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    });
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, userId: formalVictim.id, status: 'PENDING' } }))
      .toBe(1);
    const lease = await acquireLease(db, worldId);
    expect(lease).not.toBeNull();
    try {
      await new TurnLoop(db, lease!).advanceTo(0);
    } finally {
      await releaseLease(db, lease!);
    }
    await pending;
    expect(await db.general.count({ where: { worldId, userId: null } })).toBe(491);
    const human = await db.general.findUniqueOrThrow({
      where: { worldId_userId: { worldId, userId: formalVictim.id } },
    });
    expect(await db.generalTurn.count({ where: { worldId, generalId: human.id } })).toBe(30);
  });

it('장수 앞부분 검색은 두 정식 월드·사람/NPC·30칸·InputEvent를 보존하고 개인정보 없이 감사한다', async () => {
  expect(formalWorlds).toHaveLength(2);
  const before = await gameSnapshot(),
    count = await db.auditLog.count();
  for (const [worldId, generalName, expected] of [
    [formalWorlds[0]!, '조회', 1],
    [formalWorlds[1]!, '조회', 0],
    [formalWorlds[1]!, '다른월드', 1],
    [formalWorlds[0]!, '조조', 0],
    [formalWorlds[0]!, '%', 0],
    [formalWorlds[0]!, '_', 0],
    [formalWorlds[0]!, '\\', 0],
  ] as const) {
    const response = await call('admin.user.search', { query: { worldId, generalName } }, formalCookie);
    expect(response.status).toBe(200);
    expect(response.data).toHaveLength(expected);
    if (expected) expect((response.data as SearchRow[])[0]!.userId).toBe(formalVictim.id);
  }
  expect(await db.auditLog.count()).toBe(count + 7);
  const rows = await db.auditLog.findMany({ where: { actorUserId: formalActor.id } });
  expect(rows).toHaveLength(7);
  for (const row of rows) {
    expect(row).toMatchObject({ targetType: 'User', targetId: null, reason: null });
    expect(formalWorlds).toContain(row.worldId);
    expect(Object.keys(row.payload as object).sort()).toEqual(['queryKind', 'resultCount']);
    expect((row.payload as { queryKind: string }).queryKind).toBe('GENERAL_NAME');
  }
  const text = (
    await client.query('SELECT row_to_json(a)::text AS body FROM "AuditLog" a WHERE "actorUserId"=$1', [formalActor.id])
  ).rows
    .map((row) => row.body)
    .join('');
  for (const value of ['조회사람', '다른월드사람', formalVictim.id, formalVictim.email])
    expect(text.includes(value), '개인정보 비노출').toBe(false);
  expect(await gameSnapshot()).toBe(before);
});

it('상세 조회는 정식 두 월드의 사람 장수만 읽고 최신 제재50건·전체 수·고정 응답과 감사를 남긴다', async () => {
  const actor = await user('ADMIN'),
    cookie = await session(actor.id);
  const rows = Array.from({ length: 51 }, (_, index) => ({
    id: randomUUID(),
    userId: formalVictim.id,
    createdBy: actor.id,
    worldId: index % 2 ? formalWorlds[0]! : null,
    reason: index === 0 ? '<script>private-reason</script>\n원문' : `조회 제재 ${index}`,
    createdAt: new Date(now),
    expiresAt: index === 0 ? new Date(now) : index === 1 ? new Date(now + 1) : null,
    liftedAt: index === 2 ? new Date(now) : null,
    liftedBy: index === 2 ? actor.id : null,
    liftReason: index === 2 ? '상세 조회 해제 자료' : null,
  }));
  await db.sanction.createMany({ data: rows });
  const game = await gameSnapshot(),
    count = await db.auditLog.count();
  const generals = await db.general.findMany({
    where: { userId: formalVictim.id },
    orderBy: [{ world: { createdAt: 'desc' } }, { worldId: 'desc' }, { id: 'desc' }],
    include: { world: true },
  });
  expect(generals).toHaveLength(2);
  const sanctions = [...rows].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 50);
  const result = await call('admin.user.get', { userId: formalVictim.id }, cookie);
  expect(result.status).toBe(200);
  expect(result.data).toEqual({
    userId: formalVictim.id,
    email: formalVictim.email,
    status: formalVictim.status,
    role: formalVictim.role,
    createdAt: formalVictim.createdAt.toISOString(),
    emailVerified: true,
    generalCount: 2,
    sanctionCount: 51,
    recentLogins: [],
    generals: generals.map((general) => ({
      generalId: general.id,
      name: general.name,
      nationId: general.nationId,
      worldId: general.worldId,
      worldName: general.world.name,
      worldStatus: general.world.status,
    })),
    sanctions: sanctions.map((row) => ({
      sanctionId: row.id,
      worldId: row.worldId,
      worldName: row.worldId === null ? null : generals.find((general) => general.worldId === row.worldId)!.world.name,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      liftedAt: row.liftedAt?.toISOString() ?? null,
      active: row.liftedAt === null && (row.expiresAt === null || row.expiresAt.getTime() > now),
    })),
  });
  expect(await db.auditLog.count()).toBe(count + 1);
  expect(await db.auditLog.findFirst({ where: { actorUserId: actor.id } })).toMatchObject({
    action: 'user.view',
    targetType: 'User',
    targetId: formalVictim.id,
    worldId: null,
    reason: null,
    payload: { resultCount: 1, generalsDisplayed: 2, sanctionsDisplayed: 50 },
  });
  for (const value of [
    passwordHash,
    victimCookie,
    'passwordHash',
    'sessions',
    'accountTokens',
    'leadership',
    'rice',
    'gold',
    'crew',
  ])
    expect(result.raw.includes(value), '상세 응답 비공개 필드 제외').toBe(false);
  expect(await gameSnapshot()).toBe(game);
});

it('목록 경계 전용51개 참가 행도 최대50명과 정확한 전체 수·동률 순서를 반환한다', async () => {
  // 이 작은 복제 자료는 목록 상한만 검증한다. 정식 두 월드·실제 엔진 증거는 앞 사례에 있다.
  const actor = await user('ADMIN'),
    cookie = await session(actor.id),
    victim = await user();
  const human = await db.general.findUniqueOrThrow({
    where: { worldId_userId: { worldId: formalWorlds[0]!, userId: formalVictim.id } },
  });
  const ids = Array.from({ length: 51 }, () => randomUUID());
  await client.query(
    `INSERT INTO "World" SELECT (jsonb_populate_record(NULL::"World",to_jsonb(w)||jsonb_build_object('id',n.id,'status','PREOPEN','createdAt',$3::timestamp))).* FROM "World" w CROSS JOIN unnest($1::text[]) n(id) WHERE w.id=$2`,
    [ids, formalWorlds[0], new Date(now).toISOString()],
  );
  await client.query(
    `INSERT INTO "City" SELECT (jsonb_populate_record(NULL::"City",to_jsonb(c)||jsonb_build_object('worldId',n.id,'nationId',NULL))).* FROM "City" c CROSS JOIN unnest($1::text[]) n(id) WHERE c."worldId"=$2 AND c."cityKey"=$3`,
    [ids, formalWorlds[0], human.cityKey],
  );
  await client.query(
    `INSERT INTO "General" SELECT (jsonb_populate_record(NULL::"General",to_jsonb(g)||jsonb_build_object('worldId',n.id,'userId',$4::text,'nationId',NULL))).* FROM "General" g CROSS JOIN unnest($1::text[]) n(id) WHERE g."worldId"=$2 AND g.id=$3`,
    [ids, formalWorlds[0], human.id, victim.id],
  );
  const before = await gameSnapshot();
  const response = await call('admin.user.get', { userId: victim.id }, cookie);
  expect(response.status).toBe(200);
  expect(response.data).toMatchObject({ generalCount: 51, sanctionCount: 0, sanctions: [] });
  const generals = (response.data as { generals: { worldId: string; generalId: number; name: string }[] }).generals;
  expect(generals).toHaveLength(50);
  expect(generals.map((row) => row.worldId)).toEqual([...ids].sort().reverse().slice(0, 50));
  expect(generals.every((row) => row.generalId === human.id && row.name === human.name)).toBe(true);
  expect(await gameSnapshot()).toBe(before);
});

it('없는 상세 대상은 감사1행을 확정한 뒤 NOT_FOUND이며 잘못된 UUID·추가 입력은 DB를 바꾸지 않는다', async () => {
  const actor = await user('ADMIN'),
    cookie = await session(actor.id),
    userId = randomUUID();
  const count = await db.auditLog.count();
  const result = await call('admin.user.get', { userId }, cookie);
  expect(result.code).toBe('NOT_FOUND');
  expect(result.data).toBeUndefined();
  expect(await db.auditLog.count()).toBe(count + 1);
  expect(await db.auditLog.findFirst({ where: { actorUserId: actor.id } })).toMatchObject({
    action: 'user.view',
    targetType: 'User',
    targetId: userId,
    payload: { resultCount: 0, generalsDisplayed: 0, sanctionsDisplayed: 0 },
  });
  const before = await gameSnapshot(true);
  for (const input of [
    null,
    {},
    { userId: 'bad' },
    { userId: actor.id, role: 'ADMIN' },
    { userId: actor.id, worldId: randomUUID() },
  ]) {
    expect((await call('admin.user.get', input, cookie)).code).toBe('BAD_REQUEST');
    expect(await gameSnapshot(true)).toBe(before);
  }
});

it('상세 감사 저장 실패는 존재/부재 모두 결과와 원문을 숨기고 전체 DB 행을 보존한다', async () => {
  const actor = await user('ADMIN'),
    cookie = await session(actor.id),
    victim = await user();
  const before = await gameSnapshot(true);
  await client.query(
    `CREATE FUNCTION test_detail_deny() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='user.view' THEN RAISE EXCEPTION 'private-detail-database-failure'; END IF; RETURN NEW; END $$`,
  );
  await client.query(
    'CREATE TRIGGER test_detail_deny BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION test_detail_deny()',
  );
  const failures: unknown[] = [];
  try {
    for (const userId of [victim.id, randomUUID()]) {
      const result = await call('admin.user.get', { userId }, cookie);
      expect(result.code).toBe('INTERNAL_SERVER_ERROR');
      expect(result.data).toBeUndefined();
      for (const value of [victim.email, passwordHash, 'private-detail-database-failure', 'SELECT', 'INSERT'])
        expect(result.raw.includes(value), '실패 응답 비밀값 제외').toBe(false);
      expect(await gameSnapshot(true)).toBe(before);
    }
  } catch (error) {
    failures.push(error);
  }
  for (const sql of ['DROP TRIGGER test_detail_deny ON "AuditLog"', 'DROP FUNCTION test_detail_deny()']) {
    try {
      await client.query(sql);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '상세 조회 감사 실패·정리 검증 실패');
});

it('감사 INSERT 실패면 실제 HTTP 결과·입력·DB 오류를 숨기고 게임 상태와 감사를 보존한다', async () => {
  const actor = await user('ADMIN'),
    cookie = await session(actor.id),
    secret = `rollback-${randomUUID()}@example.test`;
  sensitive.add(secret);
  await user('USER', 'ACTIVE', true, secret);
  const before = await gameSnapshot(),
    count = await db.auditLog.count();
  await client.query(
    `CREATE FUNCTION test_read_deny() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='user.search' THEN RAISE EXCEPTION 'private-database-failure'; END IF; RETURN NEW; END $$`,
  );
  await client.query(
    'CREATE TRIGGER test_read_deny BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION test_read_deny()',
  );
  try {
    const response = await call('admin.user.search', { query: secret }, cookie);
    expect(response.code).toBe('INTERNAL_SERVER_ERROR');
    expect(response.data).toBeUndefined();
    for (const value of [secret, 'private-database-failure', 'SELECT', 'INSERT'])
      expect(response.raw.includes(value), '실패 응답 개인정보 비노출').toBe(false);
    expect(await db.auditLog.count()).toBe(count);
    expect(await gameSnapshot()).toBe(before);
  } finally {
    await client.query('DROP TRIGGER test_read_deny ON "AuditLog"');
    await client.query('DROP FUNCTION test_read_deny()');
  }
});

it('권한 회수가 개인정보 읽기보다 먼저 잠기면 실제 동시 HTTP 조회는 결과·감사를 내보내지 않는다', async () => {
  const actor = await user('ADMIN'),
    cookie = await session(actor.id),
    victim = await user();
  const before = await db.auditLog.count();
  await client.query('BEGIN');
  try {
    await client.query('UPDATE "User" SET role=\'USER\' WHERE id=$1', [actor.id]);
    const pending = track(() => call('admin.user.search', { query: victim.id }, cookie));
    await expect
      .poll(async () =>
        Number(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%FOR SHARE%'",
              [name],
            )
          ).rows[0]!.n,
        ),
      )
      .toBe(1);
    await client.query('COMMIT');
    const result = await pending;
    expect(['FORBIDDEN', 'INTERNAL_SERVER_ERROR']).toContain(result.code);
    expect(result.data).toBeUndefined();
    expect(result.raw.includes(victim.email), '권한 회수 응답 이메일 비노출').toBe(false);
    expect(result.raw.includes(victim.id), '권한 회수 응답 대상 비노출').toBe(false);
    expect(await db.auditLog.count()).toBe(before);
    expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).role).toBe('USER');
  } finally {
    await client.query('ROLLBACK');
  }
});

it('상세 조회가 관리자 행 잠금에서 기다리는 동안 권한을 회수하면 결과·감사가 없다', async () => {
  const actor = await user('ADMIN'),
    cookie = await session(actor.id),
    victim = await user();
  const count = await db.auditLog.count(),
    game = await gameSnapshot(),
    failures: unknown[] = [];
  let pending: Promise<Awaited<ReturnType<typeof call>>> | undefined;
  await client.query('BEGIN');
  try {
    await client.query('UPDATE "User" SET role=\'USER\' WHERE id=$1', [actor.id]);
    pending = track(() => call('admin.user.get', { userId: victim.id }, cookie));
    await expect
      .poll(async () =>
        Number(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%FOR SHARE%'",
              [name],
            )
          ).rows[0]!.n,
        ),
      )
      .toBe(1);
    await client.query('COMMIT');
    const result = await pending;
    expect(['FORBIDDEN', 'INTERNAL_SERVER_ERROR']).toContain(result.code);
    expect(result.data).toBeUndefined();
    for (const value of [victim.email, victim.id]) expect(result.raw.includes(value)).toBe(false);
    expect(await db.auditLog.count()).toBe(count);
    expect(await gameSnapshot()).toBe(game);
    expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).role).toBe('USER');
  } catch (error) {
    failures.push(error);
  }
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    failures.push(error);
  }
  if (pending) {
    const [result] = await Promise.allSettled([pending]);
    if (result!.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, '상세 조회 권한 경합·정리 실패');
});

it('감사 조회는 50개 cursor와 모든 필터를 적용하고 재귀 감사·중복·누락이 없다', async () => {
  const actor = await user('ADMIN'),
    cookie = await session(actor.id),
    targetId = randomUUID(),
    worldId = formalWorlds[0]!;
  await db.auditLog.createMany({
    data: Array.from({ length: 123 }, (_, index) => ({
      actorKind: 'ADMIN' as const,
      actorUserId: actor.id,
      action: index % 2 ? 'test.read.other' : 'test.read.page',
      targetType: 'User',
      targetId,
      worldId,
      at: new Date(now + index),
      payload: { index },
      reason: '검사',
    })),
  });
  const filter = {
    action: 'test.read.',
    actorUserId: actor.id,
    targetId,
    worldId,
    from: new Date(now).toISOString(),
    to: new Date(now + 122).toISOString(),
  };
  const count = await db.auditLog.count(),
    expected = await db.auditLog.findMany({ where: { actorUserId: actor.id }, orderBy: { id: 'desc' } });
  const all: AuditRow[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
    const response = await call('admin.audit.list', { ...filter, ...(cursor ? { cursor } : {}) }, cookie);
    expect(response.status).toBe(200);
    const page = response.data as { items: AuditRow[]; next: string | null };
    expect(page.items).toHaveLength(pageIndex < 2 ? 50 : 23);
    if (pageIndex < 2) {
      expect(page.next).toBe(page.items.at(-1)!.id);
      expect(page.next).not.toBe(cursor);
    } else expect(page.next).toBeNull();
    all.push(...page.items);
    cursor = page.next ?? undefined;
  }
  expect(all.map((row) => row.id)).toEqual(expected.map((row) => row.id.toString()));
  expect(new Set(all.map((row) => row.id)).size).toBe(123);
  expect(all[0]).toEqual({
    ...expected[0],
    id: expected[0]!.id.toString(),
    at: expected[0]!.at.toISOString(),
    inputEventId: null,
  });
  const narrower = (
    await call(
      'admin.audit.list',
      {
        ...filter,
        action: 'test.read.page',
        from: new Date(now + 10).toISOString(),
        to: new Date(now + 20).toISOString(),
      },
      cookie,
    )
  ).data as { items: AuditRow[] };
  expect(narrower.items.map((row) => (row.payload as { index: number }).index)).toEqual([20, 18, 16, 14, 12, 10]);
  for (const changed of [
    { actorUserId: randomUUID() },
    { targetId: randomUUID() },
    { worldId: formalWorlds[1] },
    { cursor: '1' },
  ])
    expect((await call('admin.audit.list', { ...filter, ...changed }, cookie)).data).toEqual({ items: [], next: null });
  expect(await db.auditLog.count()).toBe(count);
  await expect(db.auditLog.update({ where: { id: expected[0]!.id }, data: { reason: '수정' } })).rejects.toThrow();
  await expect(db.auditLog.delete({ where: { id: expected[0]!.id } })).rejects.toThrow();
});

it('실제 Pino 요청·오류 로그에 검색어·이메일·비밀번호 hash·세션 토큰이 없다', async () => {
  await delay(10);
  const text = logs.join('');
  expect(logs.length).toBeGreaterThan(20);
  expect(text.includes('request completed'), '실제 요청 로그 기록').toBe(true);
  expect(text.includes('500'), '실제 오류 응답 기록').toBe(true);
  for (const value of [...sensitive, 'private-database-failure', '조회사람', '다른월드사람'])
    expect(text.includes(value), '실제 Pino 로그 개인정보 비노출').toBe(false);
});
