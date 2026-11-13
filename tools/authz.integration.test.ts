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
import { readWorldState, saveInitialWorld } from '../apps/engine/src/world/persistence';
import { persistSeasonArchive } from '../apps/engine/src/seasonArchive';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { INTEL_FEATURE } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';

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
  'resources.worldRules',
  'general.create',
  'general.mine',
  'heritage.mine',
  'turns.get',
  'turns.set',
  'turns.edit',
  'turns.precheck',
  'commands.list',
  'home.get',
  'city.get',
  'nation.get',
  'records.general',
  'records.battles',
  'records.nation',
  'records.world',
  'records.season',
  'intel.records',
  'timelapse.frames',
  'timelapse.publicFrames',
  'ranking.generals',
  'ranking.nations',
] as const;
type Path = (typeof paths)[number];
function input(path: Path): unknown {
  if (['health', 'auth.me', 'auth.logout', 'world.list', 'world.publicMaps', 'heritage.mine'].includes(path))
    return undefined;
  if (path === 'auth.signup') return { email: `${randomUUID()}@example.test`, password };
  if (path === 'auth.login') return { email: users[0]!.email, password };
  if (path === 'timelapse.publicFrames' || path === 'records.season') return { worldId: endedWorldId };
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
async function request(path: Path, data: unknown, cookie?: string, apiBase = base) {
  const procedure: unknown = Object.getOwnPropertyDescriptor(appRouter._def.procedures, path)?.value;
  if (
    (typeof procedure !== 'object' && typeof procedure !== 'function') ||
    procedure === null ||
    !('_def' in procedure)
  )
    throw new Error('권한 검사 절차 경로를 확인하세요.');
  const definition = procedure._def;
  if (
    typeof definition !== 'object' ||
    definition === null ||
    !('type' in definition) ||
    typeof definition.type !== 'string' ||
    !['query', 'mutation', 'subscription'].includes(definition.type)
  )
    throw new Error('권한 검사 절차 종류를 확인하세요.');
  const mutation = definition.type === 'mutation';
  const encoded = JSON.stringify({ 0: data });
  const res = await fetch(`${apiBase}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`, {
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
    db.seasonGeneral.findMany({ orderBy: [{ worldId: 'asc' }, { generalId: 'asc' }] }),
    db.general.findMany({ orderBy: [{ worldId: 'asc' }, { id: 'asc' }] }),
    db.generalTurn.findMany({ orderBy: [{ worldId: 'asc' }, { generalId: 'asc' }, { slot: 'asc' }] }),
    db.inputEvent.findMany({ orderBy: { id: 'asc' } }),
    db.worldCreateRequest.findMany({ orderBy: { id: 'asc' } }),
    db.auditLog.findMany({ orderBy: { id: 'asc' } }),
    db.notice.findMany({ orderBy: { id: 'asc' } }),
    db.adminNoticeRequest.findMany({ orderBy: [{ actorUserId: 'asc' }, { idempotencyKey: 'asc' }] }),
    db.sanction.findMany({ orderBy: { id: 'asc' } }),
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "LoginRecord" ORDER BY id`,
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
  for (let index = 0; index < 5; index++)
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
  await db.$transaction((tx) => persistSeasonArchive(tx, endedWorldId, 191));
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
            } else if (path === 'heritage.mine') {
              expect(result.status).toBe(200);
              expect(result.data).toMatchObject({ userId: users[3]!.id, balance: 0, entries: [] });
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
  it('AC-P2-22 종료 장수 순위는 저장 당시 값과 공개 항목만 돌려준다', async () => {
    const input = { worldId: endedWorldId, by: 'merit' };
    const cookie = await session();
    const original = await request('records.season', input, cookie);
    expect(original).toMatchObject({
      status: 200,
      data: { result: { reason: 'END_YEAR', year: 191 }, generals: expect.any(Array) },
    });
    const rows = (original.data as { generals: Record<string, unknown>[] }).generals;
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'captures',
      'dedication',
      'experience',
      'generalId',
      'merit',
      'name',
      'nation',
      'rank',
      'value',
      'wins',
    ]);
    expect(rows[0]).toMatchObject({ merit: 0, rank: 1, value: 0 });
    expect(await request('records.season', input, await session(3))).toEqual(original);
    expect((await request('records.season', { worldId }, cookie)).code).toBe('NOT_FOUND');
    expect((await request('records.season', { ...input, userId: users[1]!.id }, cookie)).code).toBe('BAD_REQUEST');
    const generalId = Number(rows[0]!.generalId);
    const where = { worldId_id: { worldId: endedWorldId, id: generalId } };
    const general = await db.general.findUniqueOrThrow({ where, select: { battleWins: true } });
    try {
      await db.general.update({ where, data: { battleWins: general.battleWins + 1 } });
      expect(await request('records.season', input, cookie)).toEqual(original);
    } finally {
      await db.general.update({ where, data: general });
    }
  });
  it('AC-P2-07 첩보 예턴은 같은 국가에만 저장 보고서를 열고 병력을 구간으로 표시한다', async () => {
    const initial = commandInitial();
    initial.ruleFeatures = [INTEL_FEATURE, 'policy'];
    initial.generals[0]!.userId = users[0]!.id;
    initial.generals[1]!.userId = users[1]!.id;
    Object.assign(initial.generals[2]!, { userId: users[4]!.id, nationId: 1 });
    Object.assign(initial.generals[3]!, { userId: users[3]!.id, cityKey: 2 });
    for (const general of initial.generals) general.nextTurnTick = general.id === 1 ? 100 : 20_000;
    const { worldId: intelWorld, stateHash } = await saveInitialWorld(db, initial, {
      name: '첩보 권한과 재생 검증',
      turnTermMinutes: 60,
      endYear: null,
      replayFormat: 3,
    });
    const snapshot = await readWorldState(db, intelWorld);
    expect(snapshot).not.toHaveProperty('ext');
    expect(hashState(snapshot)).toBe(stateHash);
    await db.world.update({
      where: { id: intelWorld },
      data: { status: 'RUNNING', clockMode: 'ACCELERATED', clockAnchorAt: new Date(now) },
    });
    const input = { worldId: intelWorld };
    const actor = await session();
    const enemy = await session(1);
    const ally = await session(4);
    const neutral = await session(3);
    const enemyCity = { ...input, cityKey: 2 };
    expect((await request('city.get', { worldId, cityKey: state.cities[0]!.cityKey }, actor)).data).not.toHaveProperty(
      'fog',
    );
    expect((await request('city.get', enemyCity, actor)).data).toMatchObject({
      fog: { intel: null, garrisonHidden: true },
      generals: [],
    });
    expect((await request('intel.records', input, actor)).data).toEqual({ enabled: true, items: [], alerts: [] });
    expect(await request('turns.precheck', { ...input, commandKey: 'spy', args: { cityKey: 2 } }, actor)).toMatchObject(
      { status: 200, data: { ok: true } },
    );
    expect(
      (await request('turns.precheck', { ...input, commandKey: 'spy', args: { cityKey: 2 } }, neutral)).data,
    ).toMatchObject({ ok: false, code: 'NOT_NATION' });
    expect(
      (
        await request(
          'turns.set',
          {
            ...input,
            revision: 0,
            slots: [{ commandKey: 'spy', args: { cityKey: 2 } }, ...Array.from({ length: 29 }, () => null)],
          },
          actor,
        )
      ).status,
    ).toBe(200);
    const lease = await acquireLease(db, intelWorld, randomUUID(), 120_000);
    if (!lease) throw new Error('첩보 시험 월드의 리스가 필요합니다.');
    try {
      const engine = new TurnLoop(db, lease);
      await engine.advanceTo(100);
      const after = await loadReplayState(db, intelWorld);
      expect(after.state.generals[1]).toMatchObject({
        gold: initial.generals[0]!.gold - 60,
        rice: initial.generals[0]!.rice - 60,
      });
      expect(after.state.ext).toMatchObject({ intel: { 1: { 2: { tick: 100, crew: 20 } } } });
      const report = (await request('intel.records', input, actor)).data as { items: Record<string, unknown>[] };
      expect(report).toMatchObject({
        enabled: true,
        items: [{ cityKey: 2, tick: 100, year: 191, month: 1, ageMonths: 0, crew: { min: 1, max: 999 }, tech: 'even' }],
      });
      expect((await request('intel.records', input, ally)).data).toEqual(report);
      const remoteCity = (await request('city.get', enemyCity, actor)).data;
      expect(remoteCity).toMatchObject({ fog: { intel: report.items[0], garrisonHidden: true }, generals: [] });
      expect(remoteCity).not.toHaveProperty('population');
      for (const invalidLedger of [[], { 1: [] }, { 1: null }, { 1: { 2: null } }]) {
        await db.worldExtSlice.update({
          where: { worldId_key: { worldId: intelWorld, key: 'intel' } },
          data: { value: invalidLedger },
        });
        try {
          expect((await request('city.get', enemyCity, actor)).code).toBe('INTERNAL_SERVER_ERROR');
          expect((await request('intel.records', input, actor)).code).toBe('INTERNAL_SERVER_ERROR');
        } finally {
          await db.$executeRaw`
            UPDATE "WorldExtSlice" SET "value" = ${JSON.stringify(after.state.ext!.intel)}::jsonb
            WHERE "worldId" = ${intelWorld} AND "key" = 'intel'
          `;
        }
      }
      expect((await request('city.get', enemyCity, enemy)).data).toMatchObject({
        population: initial.cities[1]!.population,
        fog: { intel: null, garrisonHidden: false },
      });
      expect((await request('city.get', enemyCity, neutral)).data).toMatchObject({
        population: initial.cities[1]!.population,
        fog: { intel: null, garrisonHidden: true },
        generals: [],
      });
      const verifiedApp = await buildServer({
        db,
        now: () => now,
        publicOrigin: origin,
        logging: false,
        emailVerificationRequired: true,
      });
      try {
        const verifiedBase = await verifiedApp.listen({ port: 0, host: '127.0.0.1' });
        expect((await request('intel.records', input, actor, verifiedBase)).code).toBe('FORBIDDEN');
        expect((await request('city.get', enemyCity, actor, verifiedBase)).data).toMatchObject({
          fog: { intel: null, garrisonHidden: true },
          generals: [],
        });
      } finally {
        await verifiedApp.close();
      }
      const sanction = await db.sanction.create({
        data: { worldId: intelWorld, userId: users[0]!.id, createdBy: users[1]!.id, reason: '첩보 권한 시험' },
      });
      try {
        expect((await request('intel.records', input, actor)).code).toBe('FORBIDDEN');
        expect((await request('city.get', enemyCity, actor)).data).toMatchObject({
          fog: { intel: null, garrisonHidden: true },
          generals: [],
        });
      } finally {
        await db.sanction.delete({ where: { id: sanction.id } });
      }
      expect((await request('intel.records', input, enemy)).data).toEqual({
        enabled: true,
        items: [],
        alerts: [{ tick: 100, text: '도시2: 누군가 이 도시를 살폈습니다' }],
      });
      expect((await request('intel.records', input, neutral)).data).toEqual({ enabled: true, items: [], alerts: [] });
      expect((await request('intel.records', { ...input, nationId: 1 }, enemy)).code).toBe('BAD_REQUEST');
      await engine.advanceTo(10_000);
      expect((await request('intel.records', input, ally)).data).toMatchObject({
        items: [{ ...report.items[0], ageMonths: 1 }],
      });
    } finally {
      await releaseLease(db, lease);
    }
    const archive = await exportReplay(db, intelWorld);
    const final = await loadReplayState(db, intelWorld);
    expect(replayArchive(archive, 1)).toEqual([{ tick: 10_000, stateHash: hashState(final) }]);
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
