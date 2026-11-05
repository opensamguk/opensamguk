import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { checkContent, RESOURCE_PAYLOAD_LIMITS } from '../apps/server/src/resourceAdmin/payload';
import { RESOURCE_HTTP_LIMITS } from '../apps/server/src/resourceAdmin/httpLimits';
import { hashState } from '../packages/shared/src/node/hashState';
import { testDatabaseUrl } from './test-database';

if (!process.env.TEST_DATABASE_URL) throw new Error('전용 시험 DB가 필요합니다.');
const target = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['localhost', '127.0.0.1'].includes(target.hostname)) throw new Error('loopback 시험 DB가 필요합니다.');
const db = createDb(target.href),
  origin = 'http://127.0.0.1:5173';
const paths = [
  'resourceAdmin.list',
  'resourceAdmin.get',
  'resourceAdmin.clone',
  'resourceAdmin.save',
  'resourceAdmin.publish',
] as const;
type Path = (typeof paths)[number];
interface Reply {
  ok?: boolean;
  reason?: string;
  draftId?: string;
  meta?: {
    id: string;
    name: string;
    status: string;
    revision: number;
    contentHash: string;
    createdBy: string | null;
    updatedBy: string | null;
    publishedBy: string | null;
  };
  items?: Array<{ id: string }>;
  content?: unknown;
  report?: { status: string };
}
let app: Awaited<ReturnType<typeof buildServer>>, base: string;

async function actor(role: 'USER' | 'ADMIN' = 'ADMIN', status: 'ACTIVE' | 'SANCTIONED' = 'ACTIVE', grant = true) {
  const user = await db.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      passwordHash: 'not-a-login-hash',
      role,
      status,
      emailVerifiedAt: new Date(),
    },
  });
  if (grant) await db.resourceEditorGrant.create({ data: { userId: user.id } });
  const session = newSession(Date.now());
  await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
  return { id: user.id, cookie: `sid=${session.token}` };
}
async function fixture() {
  const original = await db.gameResource.findFirstOrThrow({
    where: { kind: 'STAT_RULES', name: 'default', status: 'PUBLISHED' },
  });
  const content = checkContent(original.content, RESOURCE_PAYLOAD_LIMITS);
  if (!content.ok) throw new Error('기준 능력치 규칙을 읽을 수 없습니다.');
  const source = await db.gameResource.create({
    data: {
      kind: 'STAT_RULES',
      name: `api_${randomUUID().replaceAll('-', '')}`,
      version: 1,
      status: 'PUBLISHED',
      publishedAt: new Date(),
      content: content.content,
      contentHash: hashState(content.content),
      source: '실제 API 시험',
    },
  });
  const draft = await db.gameResource.create({
    data: {
      kind: source.kind,
      name: source.name,
      version: 2,
      status: 'DRAFT',
      content: content.content,
      contentHash: source.contentHash,
      source: source.source,
    },
  });
  return { source, draft, content: content.content };
}
async function request(path: Path, input: unknown, cookie?: string) {
  const query = path === 'resourceAdmin.list' || path === 'resourceAdmin.get';
  const encoded = JSON.stringify({ 0: input });
  const result = await fetch(`${base}/trpc/${path}?batch=1${query ? `&input=${encodeURIComponent(encoded)}` : ''}`, {
    method: query ? 'GET' : 'POST',
    headers: { origin, ...(cookie ? { cookie } : {}), ...(!query ? { 'content-type': 'application/json' } : {}) },
    ...(!query ? { body: encoded } : {}),
  });
  const body = (await result.json()) as Array<{ result?: { data: Reply }; error?: { data: { code: string } } }>;
  return { status: result.status, data: body[0]?.result?.data, code: body[0]?.error?.data.code };
}
async function snapshot() {
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
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

beforeAll(async () => {
  app = await buildServer({ db, publicOrigin: origin, logging: false, emailVerificationRequired: true });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  try {
    await app?.close();
  } finally {
    await db.$disconnect();
  }
});

for (const path of paths)
  for (const category of categories)
    it(
      `${path} ${category}`,
      authzCase(path, category, async () => {
        const user = await actor(
            category === 'otherUser' ? 'USER' : 'ADMIN',
            category === 'sanctioned' ? 'SANCTIONED' : 'ACTIVE',
          ),
          f = await fixture();
        if (path === 'resourceAdmin.clone' && category === 'success')
          await db.gameResource.update({
            where: { id: f.draft.id },
            data: { status: 'PUBLISHED', publishedAt: new Date() },
          });
        const input =
          path === 'resourceAdmin.list'
            ? { kind: 'STAT_RULES', name: f.source.name }
            : path === 'resourceAdmin.get'
              ? { id: f.source.id }
              : path === 'resourceAdmin.clone'
                ? { sourceId: f.source.id }
                : path === 'resourceAdmin.save'
                  ? { id: f.draft.id, revision: 0, content: f.content }
                  : { id: f.draft.id, revision: 0, reason: '실제 게시 시험' };
        const before = await snapshot();
        const result = await request(
          path,
          category === 'invalidInput' ? { ...input, actorUserId: user.id } : input,
          category === 'unauthenticated' ? undefined : user.cookie,
        );
        if (category === 'success') {
          expect(result.status).toBe(200);
          if (path === 'resourceAdmin.list') expect(result.data?.items).toHaveLength(2);
          else if (path === 'resourceAdmin.get') expect(result.data).toMatchObject({ content: f.content });
          else if (path === 'resourceAdmin.clone')
            expect(result.data).toMatchObject({ ok: true, meta: { createdBy: user.id, status: 'DRAFT', revision: 0 } });
          else expect(result.data).toMatchObject({ ok: true, meta: { id: f.draft.id }, report: { status: 'pass' } });
        } else {
          expect(result.code).toBe(
            category === 'otherUser' ? 'FORBIDDEN' : category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED',
          );
          expect(await snapshot()).toBe(before);
        }
      }),
    );

it('AC-P2-27 관리자 역할만으로는 잘못된 입력을 보내도 모든 자원 API에 접근하지 못한다', async () => {
  const user = await actor('ADMIN', 'ACTIVE', false),
    before = await snapshot();
  for (const path of paths) expect((await request(path, { invalid: true }, user.cookie)).code).toBe('FORBIDDEN');
  expect(await snapshot()).toBe(before);
});

it('AC-P2-27 두 편집자의 동시 복제는 공유 초안 하나만 만들고 감사 행위자는 세션에서 정한다', async () => {
  const first = await actor(),
    second = await actor(),
    f = await fixture();
  await db.gameResource.update({ where: { id: f.draft.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
  const results = await Promise.all([
    request('resourceAdmin.clone', { sourceId: f.source.id }, first.cookie),
    request('resourceAdmin.clone', { sourceId: f.source.id }, second.cookie),
  ]);
  expect(results.filter((result) => result.data?.ok)).toHaveLength(1);
  const winner = results.find((result) => result.data?.ok)!.data!,
    id = winner.meta!.id;
  expect(results.find((result) => !result.data?.ok)?.data).toEqual({ ok: false, reason: 'DRAFT_EXISTS', draftId: id });
  expect(await db.gameResource.count({ where: { kind: 'STAT_RULES', name: f.source.name, status: 'DRAFT' } })).toBe(1);
  expect((await db.gameResource.findUniqueOrThrow({ where: { id } })).version).toBe(3);
  expect(await db.auditLog.findFirstOrThrow({ where: { targetId: id, action: 'resource.clone' } })).toMatchObject({
    actorKind: 'ADMIN',
    actorUserId: winner.meta!.createdBy,
    payload: { beforeHash: null, afterHash: f.source.contentHash },
  });
});

it('AC-P2-27 공동 저장 CAS·잘못된 초안 게시 거부·게시 판 불변과 늦은 저장을 확인한다', async () => {
  const first = await actor(),
    second = await actor(),
    f = await fixture();
  const [a, b] = await Promise.all([
    request('resourceAdmin.save', { id: f.draft.id, revision: 0, content: { invalidDraft: 1 } }, first.cookie),
    request('resourceAdmin.save', { id: f.draft.id, revision: 0, content: { invalidDraft: 2 } }, second.cookie),
  ]);
  expect([a, b].filter((result) => result.data?.ok)).toHaveLength(1);
  expect([a, b].find((result) => !result.data?.ok)?.data).toMatchObject({
    ok: false,
    reason: 'STALE',
    meta: { revision: 1 },
  });
  const before = await snapshot();
  expect(
    (await request('resourceAdmin.publish', { id: f.draft.id, revision: 1, reason: '불완전 초안' }, first.cookie)).data,
  ).toMatchObject({ ok: false, reason: 'NOT_PASS', report: { status: 'fail' } });
  expect(await snapshot()).toBe(before);
  expect(
    (await request('resourceAdmin.save', { id: f.draft.id, revision: 1, content: f.content }, second.cookie)).data,
  ).toMatchObject({ ok: true, meta: { revision: 2, updatedBy: second.id } });
  expect(
    (await request('resourceAdmin.publish', { id: f.draft.id, revision: 2, reason: '최종 검증 통과' }, first.cookie))
      .data,
  ).toMatchObject({ ok: true, meta: { status: 'PUBLISHED', revision: 2, publishedBy: first.id } });
  const published = await snapshot();
  expect(
    (await request('resourceAdmin.save', { id: f.draft.id, revision: 2, content: f.content }, second.cookie)).data,
  ).toMatchObject({ ok: false, reason: 'PUBLISHED' });
  expect(await snapshot()).toBe(published);
  await expect(
    db.gameResource.update({ where: { id: f.draft.id }, data: { content: { overwritten: true } } }),
  ).rejects.toThrow();
  await expect(db.gameResource.delete({ where: { id: f.draft.id } })).rejects.toThrow();
});

it('AC-P2-27 감사 삽입 실패는 실제 HTTP의 초안 저장과 게시를 함께 되돌린다', async () => {
  const user = await actor(),
    f = await fixture();
  await db.$executeRawUnsafe(
    `CREATE FUNCTION resource_admin_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."targetId"='${f.draft.id}' THEN RAISE EXCEPTION 'test_audit_failure'; END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    'CREATE TRIGGER resource_admin_audit_failure BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION resource_admin_audit_failure()',
  );
  try {
    const before = await snapshot();
    expect(
      (await request('resourceAdmin.save', { id: f.draft.id, revision: 0, content: { changed: true } }, user.cookie))
        .code,
    ).toBe('INTERNAL_SERVER_ERROR');
    expect(
      (await request('resourceAdmin.publish', { id: f.draft.id, revision: 0, reason: '감사 실패' }, user.cookie)).code,
    ).toBe('INTERNAL_SERVER_ERROR');
    expect(await snapshot()).toBe(before);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER resource_admin_audit_failure ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION resource_admin_audit_failure()');
  }
});

it('AC-P2-27 세 종류의 실제 내장 판을 복제·조회·저장·게시하고 원본 내용과 해시를 보존한다', async () => {
  const user = await actor();
  for (const [kind, name] of [
    ['UNIT_SET', 'basic'],
    ['STAT_RULES', 'default'],
    ['PORTRAIT_MAP', 'rtk14-map'],
  ] as const) {
    const source = await db.gameResource.findFirstOrThrow({
      where: { kind, name, status: 'PUBLISHED', version: 1 },
    });
    const copied = (await request('resourceAdmin.clone', { sourceId: source.id }, user.cookie)).data;
    expect(copied).toMatchObject({ ok: true, meta: { status: 'DRAFT', contentHash: source.contentHash } });
    const id = copied!.meta!.id;
    const read = (await request('resourceAdmin.get', { id }, user.cookie)).data!;
    expect(read.content).toEqual(source.content);
    expect(
      (await request('resourceAdmin.save', { id, revision: 0, content: read.content }, user.cookie)).data,
    ).toMatchObject({ ok: true, meta: { revision: 1 } });
    expect(
      (await request('resourceAdmin.publish', { id, revision: 1, reason: '종류별 실제 게시' }, user.cookie)).data,
    ).toMatchObject({ ok: true, report: { status: 'pass' } });
    expect(await db.gameResource.findUniqueOrThrow({ where: { id: source.id } })).toEqual(source);
  }
});

it('AC-P2-27 운영 시나리오 128KB 초과도 읽으며 지도·시나리오 문맥 누락은 통과로 바꾸지 않는다', async () => {
  const user = await actor();
  const scenario = await db.gameResource.findUniqueOrThrow({
    where: { kind_name_version: { kind: 'SCENARIO', name: 'integration191', version: 1 } },
  });
  expect(Buffer.byteLength(JSON.stringify(scenario.content))).toBeGreaterThan(128 * 1024);
  const read = await request('resourceAdmin.get', { id: scenario.id }, user.cookie);
  expect(read).toMatchObject({ status: 200, data: { content: scenario.content } });
  const cloned = (await request('resourceAdmin.clone', { sourceId: scenario.id }, user.cookie)).data!;
  expect(cloned.ok).toBe(true);
  const before = await snapshot();
  expect(
    (
      await request(
        'resourceAdmin.publish',
        { id: cloned.meta!.id, revision: 0, reason: '문맥 누락 검증' },
        user.cookie,
      )
    ).data,
  ).toMatchObject({ ok: false, reason: 'NOT_PASS', report: { status: 'incomplete' } });
  expect(await snapshot()).toBe(before);
});

it('AC-P2-27 내용·revision·필수 사유·없는 자원 오류는 실제 DB와 감사를 바꾸지 않는다', async () => {
  const user = await actor(),
    f = await fixture(),
    before = await snapshot();
  for (const input of [
    { id: f.draft.id, revision: -1, content: {} },
    { id: f.draft.id, revision: 0.5, content: {} },
    { id: f.draft.id, revision: 0, content: [] },
    { id: f.draft.id, revision: 0, content: { tooLarge: 'x'.repeat(900_000) } },
  ])
    expect((await request('resourceAdmin.save', input, user.cookie)).code).toBe('BAD_REQUEST');
  expect(
    (await request('resourceAdmin.publish', { id: f.draft.id, revision: 0, reason: '  ' }, user.cookie)).code,
  ).toBe('BAD_REQUEST');
  expect((await request('resourceAdmin.publish', { id: f.draft.id, revision: 0 }, user.cookie)).code).toBe(
    'BAD_REQUEST',
  );
  expect((await request('resourceAdmin.get', { id: randomUUID() }, user.cookie)).code).toBe('NOT_FOUND');
  expect((await request('resourceAdmin.clone', { sourceId: f.draft.id }, user.cookie)).code).toBe('BAD_REQUEST');
  expect(await snapshot()).toBe(before);
});

it('AC-P2-27 병종 내용 ID가 카탈로그 이름과 다르면 검증을 통과해도 게시하지 않는다', async () => {
  const user = await actor();
  const source = await db.gameResource.findFirstOrThrow({
    where: { kind: 'UNIT_SET', name: 'basic', status: 'PUBLISHED', version: 1 },
  });
  const cloned = (await request('resourceAdmin.clone', { sourceId: source.id }, user.cookie)).data!;
  expect(cloned.ok).toBe(true);
  const id = cloned.meta!.id;
  const current = (await request('resourceAdmin.get', { id }, user.cookie)).data!;
  const content = { ...(current.content as Record<string, unknown>), id: 'other-unit-set' };
  expect((await request('resourceAdmin.save', { id, revision: 0, content }, user.cookie)).data).toMatchObject({
    ok: true,
    report: { status: 'pass' },
  });
  const before = await snapshot();
  expect(
    (await request('resourceAdmin.publish', { id, revision: 1, reason: 'ID 불일치 검증' }, user.cookie)).data,
  ).toEqual({ ok: false, reason: 'ID_MISMATCH' });
  expect(await snapshot()).toBe(before);
});

it('AC-P2-27 자원 배치 상한을 넘으면 인코딩된 경로도 어떤 절차·감사보다 먼저 거부한다', async () => {
  const user = await actor(),
    f = await fixture(),
    before = await snapshot();
  const count = 5;
  for (const path of ['resourceAdmin.publish', '%72esourceAdmin.publish']) {
    const response = await fetch(`${base}/trpc/${Array(count).fill(path).join(',')}?batch=1`, {
      method: 'POST',
      headers: { origin, cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            index,
            { id: f.draft.id, revision: 0, reason: '실행되면 안 되는 게시' },
          ]),
        ),
      ),
    });
    expect(response.status).toBe(400);
    expect(Buffer.byteLength(await response.text())).toBeLessThan(RESOURCE_HTTP_LIMITS.envelopeMax);
    expect(await snapshot()).toBe(before);
  }
});

it('AC-P2-27 자원과 로그아웃 혼합 배치는 세션·내용·감사를 전부 보존한다', async () => {
  const user = await actor(),
    f = await fixture(),
    before = await snapshot();
  const response = await fetch(`${base}/trpc/resourceAdmin.save,auth.logout?batch=1`, {
    method: 'POST',
    headers: { origin, cookie: user.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ 0: { id: f.draft.id, revision: 0, content: { changed: true } } }),
  });
  expect(response.status).toBe(400);
  expect(await snapshot()).toBe(before);
});

it('AC-P2-27 두 JSONL 협상 경로는 자원 저장 전에 거부한다', async () => {
  const user = await actor(),
    f = await fixture(),
    before = await snapshot();
  for (const headers of [{ 'trpc-accept': 'application/jsonl' }, { accept: 'application/json, application/jsonl' }]) {
    const response = await fetch(`${base}/trpc/resourceAdmin.save?batch=1`, {
      method: 'POST',
      headers: { origin, cookie: user.cookie, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ 0: { id: f.draft.id, revision: 0, content: { changed: true } } }),
    });
    expect(response.status).toBe(400);
    expect(await snapshot()).toBe(before);
  }
});

it('AC-P2-27 최대 자원 배치는 네 초안을 실제 저장하고 결과·봉투 예산 안에 든다', async () => {
  const user = await actor(),
    fixtures = await Promise.all(Array.from({ length: 4 }, () => fixture()));
  const response = await fetch(`${base}/trpc/${fixtures.map(() => 'resourceAdmin.save').join(',')}?batch=1`, {
    method: 'POST',
    headers: { origin, cookie: user.cookie, 'content-type': 'application/json' },
    body: JSON.stringify(
      Object.fromEntries(fixtures.map((f, index) => [index, { id: f.draft.id, revision: 0, content: f.content }])),
    ),
  });
  expect(response.status).toBe(200);
  const raw = await response.text(),
    body = JSON.parse(raw) as Array<{ result: { data: Reply } }>;
  expect(body).toHaveLength(4);
  for (const [index, entry] of body.entries()) {
    expect(entry.result.data).toMatchObject({ ok: true, meta: { id: fixtures[index]!.draft.id, revision: 1 } });
    const resultBytes = Buffer.byteLength(JSON.stringify(entry.result.data));
    expect(Buffer.byteLength(JSON.stringify(entry)) - resultBytes).toBeLessThan(RESOURCE_HTTP_LIMITS.envelopeMax);
    expect(await db.auditLog.count({ where: { targetId: fixtures[index]!.draft.id, action: 'resource.save' } })).toBe(
      1,
    );
  }
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(RESOURCE_HTTP_LIMITS.wireMax);
});

it('AC-P2-27 긴 오류의 봉투를 제한하며 기존 관리자 다섯 조회 배치는 그대로 허용한다', async () => {
  const user = await actor(),
    f = await fixture(),
    before = await snapshot();
  const response = await fetch(`${base}/trpc/resourceAdmin.save?batch=1`, {
    method: 'POST',
    headers: { origin, cookie: user.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ 0: { id: f.draft.id, revision: 0, content: {}, ['\u0000'.repeat(100_000)]: true } }),
  });
  expect(response.status).toBe(400);
  const raw = await response.text();
  expect(Buffer.byteLength(raw)).toBeLessThan(RESOURCE_HTTP_LIMITS.envelopeMax);
  expect(raw).toContain('요청 값을 확인하세요.');
  expect(await snapshot()).toBe(before);
  const paths = Array(5).fill('admin.whoami').join(',');
  const normal = await fetch(`${base}/trpc/${paths}?batch=1&input=${encodeURIComponent('{}')}`, {
    headers: { origin, cookie: user.cookie },
  });
  expect(normal.status).toBe(200);
  expect(await normal.json()).toHaveLength(5);
});
