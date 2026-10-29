import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, assertLease, lockLease, releaseLease } from '../apps/engine/src/lease';
import { processInputs } from '../apps/engine/src/inputs';
import { loadReplayState } from '../apps/engine/src/monthly';
import { persistCityResourcesState } from '../apps/engine/src/cityResourcesState';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { testDatabaseUrl } from './test-database';

// AC-INT-18B: 정식 191년 자료의 실제 PG·세션·Fastify 권한 원장이다.
// 직책·집결·도시 잔액만 통제한다. 첫 달 실행·TCP·Chromium 인수로 세지 않는다.
if (!process.env.TEST_DATABASE_URL) throw new Error('전용 테스트 DB가 필요합니다.');
const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('loopback 시험 서버가 필요합니다.');
for (const key of url.searchParams.keys())
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    throw new Error('접속 대상 질의 인자는 쓸 수 없습니다.');
const db = createDb(url.href),
  origin = 'http://127.0.0.1:5173',
  now = Date.now();
const paths = ['cityResources.get', 'cityResources.allocate', 'cityResources.request'] as const;
type Path = (typeof paths)[number];
type Actor = { userId: string; generalId: number; cookie: string; email: string };
const worlds: string[] = [],
  users: string[] = [],
  running = new Set<Promise<unknown>>(),
  failures: unknown[] = [];
let failed = false,
  app: Awaited<ReturnType<typeof buildServer>> | undefined,
  worldId: string,
  otherWorldId: string,
  actor: Actor,
  peer: Actor,
  cityKey: number,
  unitId: number,
  ownRequestId: string,
  expiredCookie: string,
  revokedCookie: string;

function track<T>(action: () => Promise<T>) {
  const promise = Promise.resolve().then(action);
  running.add(promise);
  void promise.then(
    () => running.delete(promise),
    (error) => {
      failed = true;
      failures.push(error);
      running.delete(promise);
    },
  );
  return promise;
}
async function settle() {
  while (running.size) await Promise.allSettled([...running]);
}
async function call(path: Path | 'general.create' | 'campaign.unit', input: unknown, cookie?: string) {
  if (!app) throw new Error('권한 검사 서버가 없습니다.');
  const mutation = ['cityResources.allocate', 'general.create', 'campaign.unit'].includes(path),
    encoded = JSON.stringify({ 0: input });
  const response = await app.inject({
    method: mutation ? 'POST' : 'GET',
    url: `/trpc/${path}?batch=1${mutation ? '' : '&input=' + encodeURIComponent(encoded)}`,
    headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
    ...(mutation ? { payload: encoded } : {}),
  });
  const raw = response.body;
  // 비밀값을 assertion 인자로 넘기지 않아 실패 출력에도 토큰을 남기지 않는다.
  const privateValues = [actor, peer]
    .filter((value) => value !== undefined)
    .flatMap((value) => [value.email, value.cookie.slice(4)]);
  privateValues.push(
    ...[expiredCookie, revokedCookie].filter((value) => value !== undefined).map((value) => value.slice(4)),
  );
  expect(privateValues.some((value) => raw.includes(value))).toBe(false);
  expect(/passwordHash|sessionId|expiresAt|non-login-int18-authz/.test(raw)).toBe(false);
  const [entry] =
    response.json<
      Array<{ result?: { data: Record<string, unknown> }; error?: { data: { code: string; reason: string | null } } }>
    >();
  expect(entry).toBeDefined();
  return {
    status: response.statusCode,
    data: entry!.result?.data,
    code: entry!.error?.data.code,
    reason: entry!.error?.data.reason,
  };
}
async function drain() {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('고정물 입력 실행권이 없습니다.');
  try {
    for (let count = 0; count < 32; count++) {
      const processed = await db.$transaction(async (tx) => {
        await lockLease(tx, lease);
        await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
        const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        const result = await processInputs(tx, world, world.clockTick);
        await assertLease(tx, lease);
        return result;
      });
      if (!processed) return;
    }
    throw new Error('고정물 입력 수를 넘었습니다.');
  } finally {
    await releaseLease(db, lease);
  }
}
async function createActor(index: number): Promise<Actor> {
  const user = await db.user.create({
    data: { email: `${randomUUID()}@example.invalid`, passwordHash: 'non-login-int18-authz' },
  });
  users.push(user.id);
  const session = newSession(now),
    cookie = `sid=${session.token}`;
  await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
  const creating = track(() =>
    call(
      'general.create',
      {
        worldId,
        name: `권한원장${index}`,
        portraitId: null,
        leadership: 55,
        strength: 55,
        intel: 55,
        politics: 55,
        charm: 55,
      },
      cookie,
    ),
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, userId: user.id, kind: 'general.create', status: 'PENDING' } }))
    .toBe(1);
  await drain();
  expect((await creating).data).toMatchObject({ status: 'created' });
  const general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: user.id } } });
  expect(await db.generalTurn.count({ where: { worldId, generalId: general.id } })).toBe(30);
  return { userId: user.id, generalId: general.id, cookie, email: user.email };
}
const payload = () => ({ cityKey, unitId, crewType: 1100, amount: 1 });
function input(path: Path) {
  return path === 'cityResources.get'
    ? { worldId, cityKey }
    : path === 'cityResources.request'
      ? { worldId, requestId: ownRequestId }
      : { worldId, requestId: randomUUID(), expectedUserId: actor.userId, payload: payload() };
}
function digest(value: unknown) {
  return hashState(
    JSON.parse(JSON.stringify(value, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))),
  );
}
async function domain() {
  return digest({
    worlds: await db.world.findMany({ where: { id: { in: worlds } }, orderBy: { id: 'asc' } }),
    states: await Promise.all(
      worlds.map((id) => db.$transaction((tx) => loadReplayState(tx, id), { isolationLevel: 'RepeatableRead' })),
    ),
    turns: await db.generalTurn.findMany({
      where: { worldId, generalId: { in: [actor.generalId, peer.generalId] } },
      orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
    }),
  });
}
async function snapshot() {
  return digest({
    domain: await domain(),
    inputs: await db.inputEvent.findMany({ where: { worldId: { in: worlds } }, orderBy: { id: 'asc' } }),
    users: await db.user.findMany({ where: { id: { in: users } }, orderBy: { id: 'asc' } }),
    sessions: await db.session.findMany({ where: { userId: { in: users } }, orderBy: { id: 'asc' } }),
    sanctions: await db.sanction.findMany({ where: { userId: { in: users } }, orderBy: { id: 'asc' } }),
  });
}
async function denied(path: Path, value: unknown, cookie: string | undefined, status: number, code: string) {
  const before = await snapshot(),
    response = await call(path, value, cookie);
  expect(response.status).toBe(status);
  expect(response.code).toBe(code);
  expect(response.reason).toBeNull();
  expect(response.data).toBeUndefined();
  expect(await snapshot()).toBe(before);
}

beforeAll(() =>
  track(async () => {
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'int18-authz-formal191',
    });
    initial.ruleFeatures = [
      'campaign-assignment-v2',
      'campaign-v1',
      'city-resources-v1',
      'five-stats',
      'operational-map',
      'personnel',
      'policy',
      'stratagem-basic',
      'treaty',
    ];
    expect(initial.startYear).toBe(191);
    expect(initial.nations).toHaveLength(21);
    expect(initial.generals).toHaveLength(491);
    expect(initial.cities.filter((city) => city.kind === 'CITY')).toHaveLength(53);
    expect(initial.cities.filter((city) => city.kind === 'PASS')).toHaveLength(8);
    for (let index = 0; index < 2; index++) {
      const created = await saveInitialWorld(db, structuredClone(initial), {
        name: `INT18 권한 원장 통제 고정물 ${index}`,
        turnTermMinutes: 60,
        endYear: 201,
      });
      worlds.push(created.worldId);
      expect(await db.general.count({ where: { worldId: created.worldId } })).toBe(491);
      expect(await db.nation.count({ where: { worldId: created.worldId } })).toBe(21);
    }
    [worldId, otherWorldId] = worlds as [string, string];
    app = await buildServer({
      db,
      logging: false,
      publicOrigin: origin,
      now: () => now,
      production: false,
      secureCookies: false,
      emailVerificationRequired: false,
      legalPolicy: null,
    });
    await app.ready();
    await controlClock(db, worldId, 'start');
    actor = await createActor(0);
    peer = await createActor(1);
    const nations = initial.nations.slice(0, 2);
    expect(nations).toHaveLength(2);
    cityKey = nations[0]!.capitalCityKey;
    for (const [index, current] of [actor, peer].entries()) {
      const nation = nations[index]!;
      await db.general.updateMany({
        where: { worldId, nationId: nation.id, officerLevel: { in: [5, 12] } },
        data: { officerLevel: 1 },
      });
      await db.general.update({
        where: { worldId_id: { worldId, id: current.generalId } },
        data: { nationId: nation.id, cityKey: nation.capitalCityKey, officerLevel: 12 },
      });
    }
    await db.$transaction(async (tx) => {
      const before = await loadReplayState(tx, worldId),
        next = structuredClone(before.state);
      next.cityResources!.cities[String(cityKey)] = {
        gold: 10000,
        rice: 10000,
        garrison: [{ crewType: 1100, troops: 300, train: 40, atmos: 60 }],
      };
      await persistCityResourcesState(tx, worldId, before.state, next, before.campaignArmyTypes!);
    });
    const state = await db.$transaction((tx) => loadReplayState(tx, worldId));
    expect(
      (
        await call(
          'campaign.unit',
          {
            worldId,
            requestId: randomUUID(),
            payload: {
              type: 'form',
              commanderId: actor.generalId,
              crewType: 1100,
              revision: state.state.campaign!.revision,
            },
          },
          actor.cookie,
        )
      ).data,
    ).toMatchObject({ status: 'pending' });
    await drain();
    const formed = await db.$transaction((tx) => loadReplayState(tx, worldId));
    const unit = formed.state.campaign!.units.find((unit) => unit.ownerId === actor.generalId);
    expect(unit).toBeDefined();
    unitId = unit!.id;
    ownRequestId = randomUUID();
    expect(
      (
        await call(
          'cityResources.allocate',
          { worldId, requestId: ownRequestId, expectedUserId: actor.userId, payload: payload() },
          actor.cookie,
        )
      ).data,
    ).toEqual({ userId: actor.userId, requestId: ownRequestId, status: 'pending' });
    const expired = newSession(now - 31 * 24 * 60 * 60 * 1000),
      revoked = newSession(now);
    await db.session.create({ data: { id: expired.id, userId: actor.userId, expiresAt: expired.expiresAt } });
    expiredCookie = `sid=${expired.token}`;
    revokedCookie = `sid=${revoked.token}`;
    expect(await db.session.count({ where: { id: revoked.id } })).toBe(0);
    expect(await db.general.count({ where: { worldId, userId: null } })).toBe(491);
    expect(await db.generalTurn.count({ where: { worldId, generalId: peer.generalId } })).toBe(30);
    expect(await db.general.count({ where: { worldId: otherWorldId } })).toBe(491);
  }),
);
beforeEach(async () => {
  await settle();
  await db.sanction.deleteMany({ where: { userId: { in: users } } });
  await db.user.updateMany({ where: { id: { in: users } }, data: { status: 'ACTIVE' } });
});
afterAll(async () => {
  await settle();
  const errors = [...failures];
  let removedWorlds = false;
  for (const close of [
    async () => app?.close(),
    async () => {
      if (failed || errors.length) return;
      await db.sanction.deleteMany({ where: { userId: { in: users } } });
      await db.world.deleteMany({ where: { id: { in: worlds } } });
      removedWorlds = true;
    },
    async () => {
      if (removedWorlds) await db.user.deleteMany({ where: { id: { in: users } } });
    },
    async () => db.$disconnect(),
  ]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  console.info(JSON.stringify({ fixture: 'INT18-city-resources-authz', failed, removedWorlds, worlds }));
  if (errors.length) throw new AggregateError([...new Set(errors)], '도시 권한 원장 본문 또는 정리에 실패했습니다.');
});

for (const path of paths)
  for (const category of categories)
    it(`${path} ${category}`, ({ onTestFailed }) => {
      onTestFailed(() => {
        failed = true;
      });
      return track(
        authzCase(path, category, async () => {
          const value = input(path);
          if (category === 'unauthenticated') {
            for (const cookie of [undefined, expiredCookie, revokedCookie])
              await denied(path, value, cookie, 401, 'UNAUTHORIZED');
          } else if (category === 'invalidInput') {
            const invalid =
              path === 'cityResources.get'
                ? [
                    { worldId: 191, cityKey },
                    { worldId, cityKey: 0 },
                    { ...value, userId: peer.userId },
                  ]
                : path === 'cityResources.request'
                  ? [
                      { worldId, requestId: 'invalid-uuid' },
                      { ...value, userId: peer.userId },
                    ]
                  : [
                      { ...value, requestId: 'invalid-uuid' },
                      { ...value, expectedUserId: 'invalid-uuid' },
                      { ...value, payload: { ...payload(), amount: 0 } },
                      { ...value, payload: { ...payload(), userId: peer.userId } },
                    ];
            for (const invalidInput of invalid) await denied(path, invalidInput, actor.cookie, 400, 'BAD_REQUEST');
          } else if (category === 'otherUser') {
            if (path === 'cityResources.allocate') {
              await denied(path, value, peer.cookie, 409, 'CONFLICT');
              await denied(path, { ...value, expectedUserId: peer.userId }, peer.cookie, 403, 'FORBIDDEN');
            } else if (path === 'cityResources.request') {
              await denied(path, value, peer.cookie, 404, 'NOT_FOUND');
              await denied(path, { worldId: otherWorldId, requestId: ownRequestId }, actor.cookie, 404, 'NOT_FOUND');
            } else {
              const before = await snapshot(),
                response = await call(path, value, peer.cookie);
              expect(response.status).toBe(200);
              expect(response.data).toEqual({ userId: peer.userId, cityKey, visible: false });
              expect(await snapshot()).toBe(before);
            }
          } else if (category === 'sanctioned') {
            await db.sanction.create({
              data: { userId: actor.userId, worldId, createdBy: 'int18-authz-fixture', reason: '월드 권한 원장' },
            });
            if (path === 'cityResources.allocate') await denied(path, value, actor.cookie, 403, 'FORBIDDEN');
            else {
              const before = await snapshot(),
                response = await call(path, value, actor.cookie);
              expect(response.status).toBe(200);
              expect(response.data).toMatchObject({ userId: actor.userId });
              expect(await snapshot()).toBe(before);
            }
            await db.sanction.create({
              data: { userId: actor.userId, createdBy: 'int18-authz-fixture', reason: '전역 권한 원장' },
            });
            await denied(path, value, actor.cookie, 401, 'UNAUTHORIZED');
            await db.sanction.deleteMany({ where: { userId: actor.userId, worldId: null } });
            await db.user.update({ where: { id: actor.userId }, data: { status: 'SANCTIONED' } });
            await denied(path, value, actor.cookie, 401, 'UNAUTHORIZED');
          } else if (path === 'cityResources.allocate') {
            const activityBefore = await db.inputEvent.findMany({
              where: { worldId, generalId: actor.generalId, kind: 'general.active', status: 'PENDING' },
              orderBy: { id: 'asc' },
            });
            expect(activityBefore).toHaveLength(1);
            const before = await domain(),
              response = await call(path, value, actor.cookie);
            expect(response.status).toBe(200);
            expect(response.data).toEqual({ userId: actor.userId, requestId: value.requestId, status: 'pending' });
            const events = await db.inputEvent.findMany({
              where: {
                worldId,
                idempotencyKey: `city.resources:${value.requestId}`,
              },
              orderBy: { id: 'asc' },
            });
            expect(events.map(({ kind, userId, generalId, status }) => ({ kind, userId, generalId, status }))).toEqual([
              { kind: 'city.resources', userId: actor.userId, generalId: actor.generalId, status: 'PENDING' },
            ]);
            expect(events[0]!.payload).toEqual(payload());
            expect(
              await db.inputEvent.findMany({
                where: { worldId, generalId: actor.generalId, kind: 'general.active', status: 'PENDING' },
                orderBy: { id: 'asc' },
              }),
            ).toEqual(activityBefore);
            expect(await domain()).toBe(before);
          } else {
            const before = await snapshot(),
              response = await call(path, value, actor.cookie);
            expect(response.status).toBe(200);
            if (path === 'cityResources.request')
              expect(response.data).toEqual({ userId: actor.userId, requestId: ownRequestId, status: 'pending' });
            else {
              expect(response.data).toMatchObject({
                userId: actor.userId,
                cityKey,
                visible: true,
                canAllocate: true,
                resources: { gold: 10000, rice: 10000 },
              });
              expect(Object.keys(response.data!).sort()).toEqual([
                'armyTypes',
                'canAllocate',
                'cityKey',
                'resources',
                'status',
                'targets',
                'userId',
                'visible',
              ]);
              expect(response.data!.targets).toEqual([
                expect.objectContaining({ id: unitId, ownerId: actor.generalId, commanderId: actor.generalId }),
              ]);
            }
            expect(await snapshot()).toBe(before);
          }
        }),
      );
    });
