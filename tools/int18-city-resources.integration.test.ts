import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { applyRecordedInput, checkReplayOrigin, initialReplayState, type WorldInit } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { readWorldState, saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { loadReplayState } from '../apps/engine/src/monthly';
import {
  acquireLease,
  assertLease,
  lockLease,
  releaseLease,
  renewLease,
  LEASE_TTL_MS,
  type Lease,
} from '../apps/engine/src/lease';
import { assertWorldCapabilities } from '../apps/engine/src/capsGate';
import { processInputs } from '../apps/engine/src/inputs';
import { persistCityResourcesState } from '../apps/engine/src/cityResourcesState';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { readView } from '../apps/server/src/game/queries';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import type { readCityResourceBoard, readCityResourceRequest } from '../apps/server/src/game/cityResourcesApi';

// AC-INT-18B 실제 PG와 세션 쿠키를 쓰는 Fastify 주입 검사다. TCP HTTP·Chromium은 별도 인수다.
// 원생성·첫 달 재생은 수정하지 않은 정식 191년 21국·491명·61거점으로 검사한다.
// 배속 경계 시험은 실제 general.create·부곡 편성 뒤 직책·집결·도시 잔액만 통제한 고정물이다.
// 이 통제 고정물의 중간 사본 재생을 원생성 archive 재생이나 정식 한 기수 완주로 세지 않는다.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('도시 자원 전용 테스트 DB가 필요합니다.');
const target = new URL(url);
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !['', '5432', '5433', '5434', '5435'].includes(target.port) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(target.pathname) ||
  target.searchParams.has('host') ||
  target.searchParams.has('port')
)
  throw new Error('loopback 테스트 DB 주소와 이름을 확인하세요.');
const db = createDb(url),
  worldIds: string[] = [],
  userIds: string[] = [];
const origin = 'http://127.0.0.1:5173',
  now = Date.now();
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let initial: WorldInit, cleanWorld: string, isolatedWorld: string, oldWorld: string;
const running = new Set<Promise<unknown>>();
function track<T>(action: () => Promise<T>) {
  const promise = action();
  running.add(promise);
  void promise.finally(() => running.delete(promise)).catch(() => undefined);
  return promise;
}
function it(name: string, run: () => Promise<void>) {
  test(name, () => track(run));
}
beforeEach(async () => {
  await Promise.allSettled([...running]);
});
type Receipt = Awaited<ReturnType<typeof readCityResourceRequest>>;
type Board = Awaited<ReturnType<typeof readCityResourceBoard>>;
type Actor = { userId: string; generalId: number; cookie: string; unitId: number };

async function api<T = unknown>(path: string, input: unknown, cookie: string, mutation = false) {
  if (!app) throw new Error('검사 서버가 없습니다.');
  const body = JSON.stringify({ 0: input });
  const response = await app.inject({
    method: mutation ? 'POST' : 'GET',
    url: `/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(body)}`}`,
    headers: { origin, cookie, ...(mutation ? { 'content-type': 'application/json' } : {}) },
    ...(mutation ? { payload: body } : {}),
  });
  const [entry] = response.json<Array<{ result?: { data: T }; error?: { data: { code: string } } }>>();
  if (!entry) throw new Error('API 응답이 없습니다.');
  return { data: entry.result?.data, code: entry.error?.data.code };
}
async function snapshot(worldId: string, client = db) {
  return client.$transaction((tx) => loadReplayState(tx, worldId), { isolationLevel: 'RepeatableRead' });
}
async function withLease<T>(worldId: string, run: (lease: Lease, signal: AbortSignal) => Promise<T>) {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('검사 실행권이 없습니다.');
  const controller = new AbortController();
  let renewalFailure: { error: unknown } | undefined;
  const renewal = (async () => {
    while (!controller.signal.aborted) {
      try {
        await delay(LEASE_TTL_MS / 3, undefined, { signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted) renewalFailure = { error };
        break;
      }
      if (controller.signal.aborted) break;
      try {
        await renewLease(db, lease);
      } catch (error) {
        renewalFailure = { error };
        controller.abort(error);
      }
    }
  })();
  const errors: unknown[] = [];
  let result: { value: T } | undefined;
  try {
    result = { value: await run(lease, controller.signal) };
  } catch (error) {
    errors.push(error);
  }
  try {
    controller.abort();
  } catch (error) {
    errors.push(error);
  }
  try {
    await renewal;
  } catch (error) {
    errors.push(error);
  }
  if (renewalFailure) errors.push(renewalFailure.error);
  try {
    await releaseLease(db, lease);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, 'INT18 작업 또는 실행권 정리에 실패했습니다.');
  if (result === undefined) throw new Error('INT18 작업 결과가 없습니다.');
  return result.value;
}
async function drain(worldId: string, rollback = false) {
  await withLease(worldId, async (lease) => {
    for (let count = 0; count < 32; count++) {
      const processed = await db.$transaction(async (tx) => {
        await lockLease(tx, lease);
        await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
        const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        await assertWorldCapabilities(tx, world);
        const applied = await processInputs(tx, world, world.clockTick);
        await assertLease(tx, lease);
        if (rollback && applied) throw new Error('int18-after-city-input-rollback');
        return applied;
      });
      if (!processed) return;
    }
    throw new Error('준비한 입력 수를 넘었습니다.');
  });
}
async function createWorld(enabled = true) {
  const source = structuredClone(initial);
  if (!enabled) source.ruleFeatures = source.ruleFeatures!.filter((key) => key !== 'city-resources-v1');
  const { worldId } = await saveInitialWorld(db, source, {
    name: enabled ? 'INT18 정식 원생성' : 'INT18 기존 판',
    turnTermMinutes: 60,
    endYear: 201,
  });
  worldIds.push(worldId);
  return worldId;
}
async function createActor(worldId: string, index: number): Promise<Actor> {
  const userId = randomUUID();
  await db.user.create({
    data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'non-login-int18-session-fixture' },
  });
  userIds.push(userId);
  const session = newSession(now),
    cookie = `sid=${session.token}`;
  await db.session.create({ data: { id: session.id, userId, expiresAt: session.expiresAt } });
  const creating = track(() =>
    api<{ status: 'created' | 'pending' }>(
      'general.create',
      {
        worldId,
        name: `도시검사${index}`,
        portraitId: null,
        leadership: 55,
        strength: 55,
        intel: 55,
        politics: 55,
        charm: 55,
      },
      cookie,
      true,
    ),
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, userId, kind: 'general.create', status: 'PENDING' } }))
    .toBe(1);
  await drain(worldId);
  expect((await creating).data?.status).toBe('created');
  const person = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId } } });
  const campaign = (await snapshot(worldId)).state.campaign!;
  expect(campaign.sources[String(person.id)]).toMatch(/^input:\d+#general:/);
  expect(campaign.sources[String(person.id)]!.endsWith(`#general:${person.id}`)).toBe(true);
  expect(await db.generalTurn.count({ where: { worldId, generalId: person.id } })).toBe(30);
  return { userId, cookie, generalId: person.id, unitId: 0 };
}

// 부여한 직책·집결·도시 자원은 권한 경계 시험에만 쓴다. 생성 인물·출처는 실제 입력으로 만든다.
async function authorityFixture() {
  const worldId = await createWorld();
  await controlClock(db, worldId, 'start');
  const actors = [await createActor(worldId, 0), await createActor(worldId, 1)] as [Actor, Actor];
  const nation = initial.nations.find(
    (row) => initial.cities.filter((city) => city.nationId === row.id && city.kind === 'CITY').length >= 2,
  )!;
  if (!nation) throw new Error('집결 경계용 국가가 없습니다.');
  const cityKey = nation.capitalCityKey,
    otherCityKey = initial.cities.find((city) => city.nationId === nation.id && city.cityKey !== cityKey)!.cityKey;
  await withLease(worldId, async (lease) =>
    db.$transaction(async (tx) => {
      await lockLease(tx, lease);
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      await tx.world.update({ where: { id: worldId }, data: { name: 'INT18 정식 자료 기반 권한·잔량 통제 고정물' } });
      await tx.general.updateMany({
        where: { worldId, nationId: nation.id, officerLevel: { in: [5, 12] } },
        data: { officerLevel: 1 },
      });
      for (const [index, actor] of actors.entries())
        await tx.general.update({
          where: { worldId_id: { worldId, id: actor.generalId } },
          data: { nationId: nation.id, cityKey, officerLevel: index === 0 ? 12 : 5 },
        });
      const before = await loadReplayState(tx, worldId),
        next = structuredClone(before.state);
      next.cityResources!.cities[String(cityKey)] = {
        gold: 10000,
        rice: 10000,
        garrison: [{ crewType: 1100, troops: 300, train: 40, atmos: 60 }],
      };
      await persistCityResourcesState(tx, worldId, before.state, next, before.campaignArmyTypes!);
      await assertLease(tx, lease);
    }),
  );
  for (const actor of actors) {
    const revision = (await snapshot(worldId)).state.campaign!.revision,
      requestId = randomUUID();
    expect(
      (
        await api(
          'campaign.unit',
          { worldId, requestId, payload: { type: 'form', commanderId: actor.generalId, crewType: 1100, revision } },
          actor.cookie,
          true,
        )
      ).data,
    ).toMatchObject({ status: 'pending' });
    await drain(worldId);
    const state = await snapshot(worldId);
    actor.unitId = state.state.campaign!.units.find((unit) => unit.ownerId === actor.generalId)!.id;
  }
  return { worldId, actors, cityKey, otherCityKey, nationId: nation.id };
}
async function submit(
  f: Awaited<ReturnType<typeof authorityFixture>>,
  actor: Actor,
  amount: number,
  requestId = randomUUID(),
) {
  const payload = { cityKey: f.cityKey, unitId: actor.unitId, crewType: 1100, amount };
  const result = await api<Receipt>(
    'cityResources.allocate',
    { worldId: f.worldId, requestId, expectedUserId: actor.userId, payload },
    actor.cookie,
    true,
  );
  expect(result.code).toBeUndefined();
  expect(result.data).toMatchObject({ userId: actor.userId, requestId, status: 'pending' });
  return { requestId, payload };
}
async function receipt(worldId: string, actor: Actor, requestId: string) {
  const response = await api<Receipt>('cityResources.request', { worldId, requestId }, actor.cookie);
  expect(response.code).toBeUndefined();
  return response.data!;
}

beforeAll(() =>
  track(async () => {
    initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'int18-formal-city-resources',
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
    app = await buildServer({
      db,
      logging: false,
      publicOrigin: origin,
      production: false,
      secureCookies: false,
      emailVerificationRequired: false,
      legalPolicy: null,
    });
    cleanWorld = await createWorld();
    isolatedWorld = await createWorld();
    oldWorld = await createWorld(false);
    await controlClock(db, cleanWorld, 'start');
  }),
);
afterAll(async () => {
  await Promise.allSettled([...running]);
  const errors: unknown[] = [];
  for (const close of [
    async () => app?.close(),
    async () => db.sanction.deleteMany({ where: { OR: [{ worldId: { in: worldIds } }, { userId: { in: userIds } }] } }),
    async () => db.world.deleteMany({ where: { id: { in: worldIds } } }),
    async () => db.user.deleteMany({ where: { id: { in: userIds } } }),
    async () => db.$disconnect(),
  ]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'INT18 검사 자원 정리를 마치지 못했습니다.');
});

describe('AC-INT-18B 정식 원생성·기존 판과 실제 PG', () => {
  it('21국491명·53도시8관문의 초기 원장은 0이며 API/loader/재생이 같다', async () => {
    expect(initial.generals).toHaveLength(491);
    expect(initial.nations).toHaveLength(21);
    expect(initial.cities.filter((city) => city.kind === 'CITY')).toHaveLength(53);
    expect(initial.cities.filter((city) => city.kind === 'PASS')).toHaveLength(8);
    const row = await db.world.findUniqueOrThrow({ where: { id: cleanWorld } });
    const replay = await snapshot(cleanWorld),
      view = await db.$transaction((tx) => readView(tx, cleanWorld));
    const origin: unknown = row.replayOrigin;
    checkReplayOrigin(origin);
    expect(origin.version).toBe(3);
    expect(Object.hasOwn(origin.initial, 'cityResources')).toBe(false);
    expect(row.initialStateHash).toBe(hashState(origin.initial));
    expect(Object.hasOwn(await readWorldState(db, cleanWorld), 'cityResources')).toBe(false);
    expect(replay).toEqual(initialReplayState(origin.initial, origin.version === 3 ? origin.featureData : undefined));
    expect(view.cityResources).toEqual(replay.state.cityResources);
    expect(Object.keys(replay.state.cityResources!.cities)).toHaveLength(61);
    expect(
      Object.values(replay.state.cityResources!.cities).every(
        (city) => city.gold === 0 && city.rice === 0 && city.garrison.length === 0,
      ),
    ).toBe(true);
    expect((await db.world.findUniqueOrThrow({ where: { id: oldWorld } })).cityResourcesState).toBeNull();
    expect(Object.hasOwn((await snapshot(oldWorld)).state, 'cityResources')).toBe(false);
  });
});
describe('AC-INT-18B 정식 자료 기반 권한·잔량 통제 고정물', () => {
  it('동시200명 요청 둘은 도시300명에서 한 번만 성공하고 두 월드를 격리한다', async () => {
    const f = await authorityFixture(),
      before = await snapshot(f.worldId),
      isolated = hashState(await snapshot(isolatedWorld));
    const requests = await Promise.all(f.actors.map((actor) => submit(f, actor, 200)));
    await drain(f.worldId);
    const receipts = await Promise.all(
      requests.map((request, index) => receipt(f.worldId, f.actors[index]!, request.requestId)),
    );
    expect(receipts.filter((row) => row.status === 'applied')).toHaveLength(1);
    expect(receipts.filter((row) => row.status === 'rejected')).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ code: 'NO_CREW' }) }),
    ]);
    const after = await snapshot(f.worldId),
      city = after.state.cityResources!.cities[String(f.cityKey)]!;
    expect(city.garrison[0]!.troops).toBe(100);
    expect(city.gold).toBe(before.state.cityResources!.cities[String(f.cityKey)]!.gold);
    expect(city.rice).toBe(before.state.cityResources!.cities[String(f.cityKey)]!.rice);
    expect(after.state.campaign!.units.reduce((sum, row) => sum + row.troops, 0)).toBe(200);
    expect(after.state.campaign!.units.find((unit) => unit.troops === 200)).toMatchObject({ train: 40, atmos: 60 });
    expect(after.state.nations).toEqual(before.state.nations);
    for (const actor of f.actors) {
      expect(after.state.generals[actor.generalId]!.crew).toBe(0);
      expect(after.state.generals[actor.generalId]!.gold).toBe(before.state.generals[actor.generalId]!.gold);
      expect(after.state.generals[actor.generalId]!.rice).toBe(before.state.generals[actor.generalId]!.rice);
      expect(after.turns[actor.generalId]).toEqual(before.turns[actor.generalId]);
      expect(after.turns[actor.generalId]).toHaveLength(30);
    }
    expect(hashState(await snapshot(isolatedWorld))).toBe(isolated);
  });
  it('계정별 UUID 중복은 한 번만 저장하고 다른 내용·예상 계정 불일치는 접수하지 않는다', async () => {
    const f = await authorityFixture(),
      actor = f.actors[0],
      requestId = randomUUID();
    const first = await submit(f, actor, 50, requestId);
    expect(
      (
        await api<Receipt>(
          'cityResources.allocate',
          { worldId: f.worldId, requestId, expectedUserId: actor.userId, payload: first.payload },
          actor.cookie,
          true,
        )
      ).data?.status,
    ).toBe('pending');
    expect(
      await db.inputEvent.count({
        where: {
          worldId: f.worldId,
          userId: actor.userId,
          kind: 'city.resources',
          idempotencyKey: `city.resources:${requestId}`,
        },
      }),
    ).toBe(1);
    expect(
      (
        await api(
          'cityResources.allocate',
          { worldId: f.worldId, requestId, expectedUserId: actor.userId, payload: { ...first.payload, amount: 51 } },
          actor.cookie,
          true,
        )
      ).code,
    ).toBe('CONFLICT');
    expect(
      (
        await api(
          'cityResources.allocate',
          { worldId: f.worldId, requestId: randomUUID(), expectedUserId: actor.userId, payload: first.payload },
          f.actors[1].cookie,
          true,
        )
      ).code,
    ).toBe('CONFLICT');
    expect((await api('cityResources.request', { worldId: f.worldId, requestId }, f.actors[1].cookie)).code).toBe(
      'NOT_FOUND',
    );
    expect((await api('cityResources.request', { worldId: isolatedWorld, requestId }, actor.cookie)).code).toBe(
      'NOT_FOUND',
    );
    await submit(f, f.actors[1], 50, requestId);
    expect(
      await db.inputEvent.count({
        where: { worldId: f.worldId, kind: 'city.resources', idempotencyKey: `city.resources:${requestId}` },
      }),
    ).toBe(2);
    await drain(f.worldId);
    expect(await receipt(f.worldId, actor, requestId)).toMatchObject({
      userId: actor.userId,
      requestId,
      status: 'applied',
      result: { amount: 50 },
    });
    expect(await receipt(f.worldId, f.actors[1], requestId)).toMatchObject({
      userId: f.actors[1].userId,
      requestId,
      status: 'applied',
      result: { amount: 50, unitId: f.actors[1].unitId },
    });
    const ledger = (await snapshot(f.worldId)).state.cityResources!.cities[String(f.cityKey)]!;
    expect(ledger.garrison[0]!.troops).toBe(200);
  });
  for (const changed of ['location', 'office', 'capture'] as const)
    it(`접수 뒤 ${changed}가 바뀌면 엔진이 다시 검사한다`, async () => {
      const f = await authorityFixture(),
        actor = f.actors[0],
        request = await submit(f, actor, 50);
      if (changed === 'location')
        await db.general.update({
          where: { worldId_id: { worldId: f.worldId, id: actor.generalId } },
          data: { cityKey: f.otherCityKey },
        });
      if (changed === 'office')
        await db.general.update({
          where: { worldId_id: { worldId: f.worldId, id: actor.generalId } },
          data: { officerLevel: 4 },
        });
      if (changed === 'capture')
        await db.city.update({
          where: { worldId_cityKey: { worldId: f.worldId, cityKey: f.cityKey } },
          data: { nationId: initial.nations.find((row) => row.id !== f.nationId)!.id },
        });
      const before = await snapshot(f.worldId);
      await drain(f.worldId);
      expect(await receipt(f.worldId, actor, request.requestId)).toMatchObject({
        status: 'rejected',
        result: { code: changed === 'location' ? 'BAD_STATE' : changed === 'office' ? 'PROTECTED' : 'NOT_OWN_CITY' },
      });
      const after = await snapshot(f.worldId);
      expect(after.state.cityResources).toEqual(before.state.cityResources);
      expect(after.state.campaign).toEqual(before.state.campaign);
    });
  for (const global of [false, true])
    it(`접수 뒤 추가한 ${global ? '전역' : '월드'} 제재는 처리 때 적용한다`, async () => {
      const f = await authorityFixture(),
        actor = f.actors[0],
        request = await submit(f, actor, 50);
      const sanction = await db.sanction.create({
        data: {
          userId: actor.userId,
          worldId: global ? null : f.worldId,
          reason: 'INT18 처리 시점 권한 시험',
          createdBy: 'test-fixture',
        },
      });
      const before = await snapshot(f.worldId);
      await drain(f.worldId);
      const event = await db.inputEvent.findUniqueOrThrow({
        where: {
          worldId_userId_idempotencyKey: {
            worldId: f.worldId,
            userId: actor.userId,
            idempotencyKey: `city.resources:${request.requestId}`,
          },
        },
      });
      expect(event.status).toBe('REJECTED');
      expect(event.result).toMatchObject({ code: 'ACTOR_SANCTIONED' });
      expect((await snapshot(f.worldId)).state.cityResources).toEqual(before.state.cityResources);
      await db.sanction.update({ where: { id: sanction.id }, data: { liftedAt: new Date(now) } });
    });
  it('실제 입력 저장 뒤 오류는 도시·부곡·순서·결과를 함께 롤백한다', async () => {
    const f = await authorityFixture(),
      actor = f.actors[0],
      request = await submit(f, actor, 50);
    const before = await snapshot(f.worldId),
      sequence = (await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).actionSequence;
    await expect(drain(f.worldId, true)).rejects.toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ message: 'int18-after-city-input-rollback' })]),
    });
    expect(await snapshot(f.worldId)).toEqual(before);
    expect((await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).actionSequence).toBe(sequence);
    expect(await receipt(f.worldId, actor, request.requestId)).toMatchObject({ status: 'pending' });
    await drain(f.worldId);
    expect(await receipt(f.worldId, actor, request.requestId)).toMatchObject({ status: 'applied' });
  });
  it('재접속과 통제 사본에서 실제 입력 기록 재생의 도시·부곡·30칸이 같다', async () => {
    const f = await authorityFixture(),
      actor = f.actors[0],
      before = await snapshot(f.worldId);
    const sequence = (await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).actionSequence;
    await submit(f, actor, 50);
    await drain(f.worldId);
    const after = await snapshot(f.worldId),
      reopened = createDb(url);
    try {
      expect(await snapshot(f.worldId, reopened)).toEqual(after);
    } finally {
      await reopened.$disconnect();
    }
    let replay = before;
    const events = await db.inputEvent.findMany({
      where: { worldId: f.worldId, sequence: { gt: sequence } },
      orderBy: { sequence: 'asc' },
    });
    for (const event of events) {
      if (event.status === 'PENDING' || event.sequence === null) throw new Error('확정하지 않은 입력입니다.');
      replay = applyRecordedInput(replay, {
        kind: event.kind,
        sequence: event.sequence!,
        tick: event.tick,
        generalId: event.generalId,
        status: event.status,
        payload: event.payload,
        result: event.result,
      });
    }
    expect(replay).toEqual(after);
    const board = await api<Board>('cityResources.get', { worldId: f.worldId, cityKey: f.cityKey }, actor.cookie);
    expect(board.data).toMatchObject({ userId: actor.userId, visible: true, canAllocate: true });
    const enemy = initial.cities.find((city) => city.nationId !== null && city.nationId !== f.nationId)!.cityKey;
    expect((await api('cityResources.get', { worldId: f.worldId, cityKey: enemy }, actor.cookie)).data).toEqual({
      userId: actor.userId,
      cityKey: enemy,
      visible: false,
    });
  });
});
describe('AC-INT-18B 수정하지 않은 정식 491명 첫 달과 원생성 archive', () => {
  it('첫 달 전반 NPC를 실제 새 판으로 실행한다', async () => {
    await withLease(cleanWorld, (lease, signal) => new TurnLoop(db, lease).advanceTo(5000, signal));
  });
  it('첫 달 후반과 월 정산을 실제 새 판으로 실행한다', async () => {
    await withLease(cleanWorld, (lease, signal) => new TurnLoop(db, lease).advanceTo(10000, signal));
  });
  it('정식 원생성 archive의 동일 시드 재생과 DB 월 해시가 같다', async () => {
    const archive = await exportReplay(db, cleanWorld),
      first = replayArchive(archive, 1);
    expect(first).toHaveLength(1);
    expect(replayArchive(archive, 1)).toEqual(first);
    expect(first[0]!.stateHash).toBe(hashState(await snapshot(cleanWorld)));
    expect((await snapshot(isolatedWorld)).state.cityResources).toEqual(
      initialReplayState(initial, { policy: { version: 1, turnTermMinutes: 60 } }).state.cityResources,
    );
  });
});
