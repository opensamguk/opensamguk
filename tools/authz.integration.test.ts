import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { appRouter } from '../apps/server/src/router';
import { authzCase } from '../apps/server/src/authz/case';
import { exemptions } from '../apps/server/src/authz/exemptions';
import { categories } from '../apps/server/src/authz/coverage';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { readFixture } from '../apps/server/test/readFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = 1_800_000_000_000;
const origin = 'http://127.0.0.1:5173';
const app = await buildServer({ db, now: () => now, publicOrigin: origin, logging: false });
const password = randomUUID();
let base: string;
let worldId: string;
let endedWorldId: string;
let users: Array<{ id: string; email: string }>;
let state: Awaited<ReturnType<typeof readFixture>>;
const paths = [
  'health',
  'auth.signup',
  'auth.login',
  'auth.logout',
  'auth.me',
  'world.list',
  'world.publicMaps',
  'world.summary',
  'world.map',
  'general.create',
  'general.mine',
  'turns.get',
  'turns.set',
  'turns.edit',
  'turns.precheck',
  'commands.list',
  'home.get',
  'city.get',
  'nation.get',
  'records.general',
  'records.nation',
  'records.world',
  'timelapse.frames',
  'timelapse.publicFrames',
  'ranking.generals',
  'ranking.nations',
] as const;
type Path = (typeof paths)[number];
function input(path: Path): unknown {
  if (['health', 'auth.me', 'auth.logout', 'world.list', 'world.publicMaps'].includes(path)) return undefined;
  if (path === 'auth.signup') return { email: `${randomUUID()}@example.test`, password };
  if (path === 'auth.login') return { email: users[0]!.email, password };
  if (path === 'timelapse.publicFrames') return { worldId: endedWorldId };
  if (path === 'general.create')
    return { worldId, name: '보안장수', leadership: 55, strength: 55, intel: 55, portraitId: 10001 };
  if (path === 'turns.set') return { worldId, revision: 0, slots: Array.from({ length: 30 }, () => null) };
  if (path === 'turns.edit') return { worldId, revision: 1, op: { shift: 1 } };
  if (path === 'turns.precheck') return { worldId, commandKey: 'rest', args: {} };
  if (path === 'city.get') return { worldId, cityKey: state.cities[0]!.cityKey };
  if (path === 'nation.get') return { worldId, nationId: 2 };
  if (path === 'ranking.generals') return { worldId, by: 'dedication' };
  if (path === 'ranking.nations') return { worldId, by: 'power' };
  return { worldId };
}
async function session(user = 0) {
  const value = newSession(now);
  await db.session.create({ data: { id: value.id, userId: users[user]!.id, expiresAt: value.expiresAt } });
  return `sid=${value.token}`;
}
async function request(path: Path, data: unknown, cookie?: string) {
  const mutation = appRouter._def.procedures[path]._def.type === 'mutation';
  const encoded = JSON.stringify({ 0: data });
  const res = await fetch(`${base}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`, {
    method: mutation ? 'POST' : 'GET',
    headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
    ...(mutation ? { body: encoded } : {}),
  });
  const body = (await res.json())[0] as { result?: { data: unknown }; error?: { data: { code: string } } };
  return { status: res.status, data: body.result?.data, code: body.error?.data.code };
}
async function snapshot() {
  const tables = await Promise.all([
    db.user.findMany({ orderBy: { id: 'asc' } }),
    db.session.findMany({ orderBy: { id: 'asc' } }),
    db.world.findMany({ orderBy: { id: 'asc' } }),
    db.general.findMany({ orderBy: [{ worldId: 'asc' }, { id: 'asc' }] }),
    db.generalTurn.findMany({ orderBy: [{ worldId: 'asc' }, { generalId: 'asc' }, { slot: 'asc' }] }),
    db.inputEvent.findMany({ orderBy: { id: 'asc' } }),
    db.auditLog.findMany({ orderBy: { id: 'asc' } }),
    db.notice.findMany({ orderBy: { id: 'asc' } }),
    db.adminNoticeRequest.findMany({ orderBy: [{ actorUserId: 'asc' }, { idempotencyKey: 'asc' }] }),
    db.sanction.findMany({ orderBy: { id: 'asc' } }),
    db.publicMapSnapshot.findMany({ orderBy: [{ worldId: 'asc' }, { takenAt: 'asc' }] }),
    db.city.findMany({ orderBy: [{ worldId: 'asc' }, { cityKey: 'asc' }] }),
    db.nation.findMany({ orderBy: [{ worldId: 'asc' }, { id: 'asc' }] }),
  ]);
  // 실패 출력에도 이메일·세션·비밀번호 해시가 나오지 않게 비교용 해시만 반환한다.
  return {
    counts: tables.map((rows) => rows.length),
    hash: createHash('sha256')
      .update(JSON.stringify(tables, (_, v) => (typeof v === 'bigint' ? String(v) : v)))
      .digest('hex'),
    revisions: await db.general.findMany({ select: { id: true, turnRevision: true }, orderBy: { id: 'asc' } }),
  };
}

beforeAll(async () => {
  await db.world.deleteMany();
  await db.user.deleteMany();
  const passwordHash = await hashPassword(password);
  users = [];
  for (let index = 0; index < 4; index++)
    users.push(
      await db.user.create({
        data: { email: `${randomUUID()}@example.test`, passwordHash, status: index === 2 ? 'SANCTIONED' : 'ACTIVE' },
        select: { id: true, email: true },
      }),
    );
  state = await readFixture();
  state.generals[0]!.userId = users[0]!.id;
  state.generals[2]!.userId = users[1]!.id;
  ({ worldId } = await saveInitialWorld(db, state, { name: '권한 대조', turnTermMinutes: 60, endYear: null }));
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  ({ worldId: endedWorldId } = await saveInitialWorld(db, state, {
    name: '종료 월드 권한 대조',
    turnTermMinutes: 60,
    endYear: null,
  }));
  await db.world.update({ where: { id: endedWorldId }, data: { status: 'ENDED' } });
  await db.worldResult.create({
    data: {
      worldId: endedWorldId,
      reason: 'END_YEAR',
      endedYear: 191,
      endedMonth: 1,
      endedTick: 10000,
      endedSequence: 1,
      remainingNations: state.nations.length,
      finalStateHash: 'public-timelapse-final',
      endedAt: new Date(now),
    },
  });
  await db.yearbookSnapshot.create({
    data: {
      worldId: endedWorldId,
      tick: 10000,
      year: 191,
      month: 1,
      sequence: 1,
      stateHash: 'public-timelapse-frame',
      data: { cities: state.cities.map(({ cityKey, nationId }) => ({ cityKey, nationId })) },
    },
  });
  await db.yearbookNation.createMany({
    data: state.nations.map(({ id, name, color }) => ({
      worldId: endedWorldId,
      tick: 10000,
      nationId: id,
      name,
      color,
    })),
  });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany();
  await db.user.deleteMany();
  await db.$disconnect();
});

describe('T3-04 실제 AppRouter HTTP·PostgreSQL 실행 대조', () => {
  for (const path of paths) {
    for (const category of categories) {
      if (exemptions.some((entry) => entry.path === path && entry.category === category)) continue;
      it(
        `${path} ${category}`,
        authzCase(path, category, async () => {
          const publicPath =
            path.startsWith('auth.') ||
            path === 'health' ||
            path === 'world.publicMaps' ||
            path === 'timelapse.publicFrames';
          const cookie =
            category === 'unauthenticated'
              ? undefined
              : await session(
                  category === 'sanctioned' ? 2 : category === 'otherUser' || path === 'general.create' ? 3 : 0,
                );
          const data =
            category === 'invalidInput'
              ? { unexpected: true }
              : path === 'auth.login' && category === 'sanctioned'
                ? { email: users[2]!.email, password }
                : input(path);
          const commandsOwner = path === 'commands.list' && category === 'otherUser' ? await session() : undefined;
          const before = await snapshot();
          const result = await request(path, data, cookie);
          if (category === 'otherUser') {
            if (path === 'commands.list') {
              const owner = await request(path, data, commandsOwner);
              expect(owner.status).toBe(200);
              expect(owner.code).toBeUndefined();
              expect(result.status).toBe(200);
              expect(result.code).toBeUndefined();
              expect(result.data).toEqual(owner.data);
              expect(result.data).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ key: 'rest' }),
                  expect.objectContaining({ key: 'farm' }),
                ]),
              );
            } else {
              // 이 월드에 자기 장수가 없는 사용자는 남의 장수·예턴·기록을 대신 고를 수 없다.
              expect(result.code).toBe('NOT_FOUND');
            }
            expect(await snapshot()).toEqual(before);
          } else if (category === 'invalidInput') {
            expect(result.code).toBe('BAD_REQUEST');
            expect(await snapshot()).toEqual(before);
          } else if (
            (category === 'unauthenticated' || category === 'sanctioned') &&
            (!publicPath || (path === 'auth.login' && category === 'sanctioned'))
          ) {
            expect(result.code).toBe('UNAUTHORIZED');
            expect(await snapshot()).toEqual(before);
          } else {
            expect(result.status).toBe(200);
            expect(result.code).toBeUndefined();
            expect(result.data).toBeDefined();
            if (path === 'auth.me')
              expect((result.data as { user: unknown }).user === null).toBe(category !== 'success');
            if (path === 'general.create') {
              expect(result.data).toEqual({ status: 'pending' });
              expect(
                await db.inputEvent.count({
                  where: { worldId, userId: users[3]!.id, kind: 'general.create', status: 'PENDING' },
                }),
              ).toBe(1);
            }
            if (path === 'turns.set' || path === 'turns.edit') expect((result.data as { ok: boolean }).ok).toBe(true);
            if (path === 'health') expect(result.data).toMatchObject({ server: 'ok', db: 'ok' });
            if (path === 'timelapse.publicFrames') {
              const data = result.data as { items: unknown[]; map: unknown };
              expect(data.items).toHaveLength(1);
              expect(data.map).not.toBeNull();
              if (category === 'sanctioned') expect(result.data).toEqual((await request(path, input(path))).data);
            }
          }
        }),
      );
    }
    if (path !== 'health')
      it(`${path} 타인 actor ID 주입은 거부하고 DB와 revision을 보존한다`, async () => {
        const cookie = await session();
        const before = await snapshot();
        const data = input(path);
        const result = await request(
          path,
          {
            ...(typeof data === 'object' && data !== null ? data : {}),
            userId: users[1]!.id,
            generalId: state.generals[2]!.id,
          },
          cookie,
        );
        expect(result.code).toBe('BAD_REQUEST');
        expect(await snapshot()).toEqual(before);
      });
  }
  it('두 세션의 mine과 me가 분리되고 로그아웃은 다른 세션을 지우지 않는다', async () => {
    const a = await session();
    const b = await session(1);
    expect((await request('general.mine', { worldId }, a)).data).toHaveProperty('general.id', state.generals[0]!.id);
    expect((await request('general.mine', { worldId }, b)).data).toHaveProperty('general.id', state.generals[2]!.id);
    expect((await request('auth.me', undefined, b)).data).toHaveProperty('user.id', users[1]!.id);
    await request('auth.logout', undefined, a);
    expect((await request('auth.me', undefined, b)).data).toHaveProperty('user.id', users[1]!.id);
  });
  it('health의 임의 입력은 계정 정보를 더하거나 DB를 바꾸지 않는다', async () => {
    const before = await snapshot();
    const result = await request('health', { userId: users[1]!.id, unexpected: true });
    expect(result.status).toBe(200);
    expect(Object.keys(result.data as object).sort()).toEqual(['db', 'ruleset', 'server']);
    expect(await snapshot()).toEqual(before);
  });
  it('제재 계정의 기존 이메일로 다시 가입해도 계정과 세션이 늘지 않는다', async () => {
    const cookie = await session(2);
    const before = await snapshot();
    expect((await request('auth.signup', { email: users[2]!.email, password }, cookie)).code).toBe('CONFLICT');
    expect(await snapshot()).toEqual(before);
  });
});
