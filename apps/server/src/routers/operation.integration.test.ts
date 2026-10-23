import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { inferRouterOutputs } from '@trpc/server';
import { createDb, type Prisma } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { readFixture } from '../../test/readFixture';
import { authzCase } from '../authz/case';
import { newSession } from '../auth/session';
import { readView } from '../game/queries';
import type { AppRouter } from '../router';
import { buildServer } from '../server';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(databaseUrl);
const now = 1_800_000_000_000;
const origin = 'http://127.0.0.1:5173';
const app = await buildServer({ db, now: () => now, logging: false });
const worldIds: string[] = [],
  userIds: string[] = [];
let base: string;
let initial: Awaited<ReturnType<typeof readFixture>>;
type Output = inferRouterOutputs<AppRouter>;
type Route =
  | 'operation.create'
  | 'operation.list'
  | 'operation.get'
  | 'operation.suggest'
  | 'operation.close'
  | 'inspection.members';
type Result = {
  'operation.create': Output['operation']['create'];
  'operation.list': Output['operation']['list'];
  'operation.get': Output['operation']['get'];
  'operation.suggest': Output['operation']['suggest'];
  'operation.close': Output['operation']['close'];
  'inspection.members': Output['inspection']['members'];
};
async function rpc<R extends Route>(path: R, input: unknown, cookie?: string) {
  const mutation = path === 'operation.create' || path === 'operation.close';
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${base}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const body = (
    (await response.json()) as Array<{ result?: { data: Result[R] }; error?: { data: { code: string } } }>
  )[0]!;
  return { status: response.status, data: body.result?.data, error: body.error?.data.code };
}
async function user(sanctioned = false) {
  const row = await db.user.create({
    data: {
      email: `t211-${randomUUID()}@example.test`,
      passwordHash: 'unused',
      status: sanctioned ? 'SANCTIONED' : 'ACTIVE',
    },
  });
  userIds.push(row.id);
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: row.id, expiresAt: session.expiresAt } });
  return { id: row.id, cookie: `sid=${session.token}` };
}
async function fixture() {
  const alice = await user(),
    bob = await user(),
    outsider = await user(),
    eve = await user(),
    sanctioned = await user(true);
  const world = await db.world.create({
    data: {
      name: '작전 API 전용',
      scenarioKey: initial.scenarioKey,
      mapKey: initial.mapKey,
      unitSetKey: initial.unitSetKey,
      seed: initial.seed,
      startYear: initial.startYear,
      turnTermMinutes: 30,
      status: 'RUNNING',
      clockTick: 0,
      clockAnchorAt: new Date(now),
      policyFromSequence: 0,
      initialStateHash: hashState(initial),
      statRules: initial.statRules as unknown as Prisma.InputJsonValue,
      unitSet: initial.unitSet as unknown as Prisma.InputJsonValue,
    },
  });
  const worldId = world.id;
  worldIds.push(worldId);
  await db.nation.createMany({ data: initial.nations.map((nation) => ({ ...nation, worldId, capitalCityKey: null })) });
  await db.city.createMany({ data: initial.cities.map((city) => ({ ...city, worldId })) });
  const generals = [
    { ...initial.generals[0]!, id: 1, userId: alice.id, nationId: 1, officerLevel: 5 },
    { ...initial.generals[1]!, id: 2, userId: bob.id, nationId: 1, officerLevel: 1 },
    { ...initial.generals[2]!, id: 3, userId: eve.id, nationId: 2, officerLevel: 12 },
    { ...initial.generals[3]!, id: 4, userId: outsider.id, nationId: 1, officerLevel: 1 },
    { ...initial.generals[0]!, id: 5, userId: null, nationId: 1, officerLevel: 0 },
  ];
  await db.general.createMany({
    data: generals.map((general) => ({
      ...general,
      worldId,
      crew: 100,
      train: 100,
      atmos: 100,
      defaultPolicy: 'none',
      lastActiveTick: general.userId === null ? null : 0,
    })),
  });
  await db.generalTurn.createMany({
    data: generals.flatMap(({ id }) =>
      Array.from({ length: 30 }, (_, slot) => ({
        worldId,
        generalId: id,
        slot,
        commandKey: 'rest',
        args: {},
        explicit: true,
      })),
    ),
  });
  const operation = await db.operation.create({
    data: {
      worldId,
      nationId: 1,
      targetCityKey: initial.cities[1]!.cityKey,
      targetTick: 120000n,
      minCrew: 100,
      minTrain: 90,
      minAtmos: 90,
      createdById: 1,
      members: { create: [1, 2].map((generalId) => ({ worldId, generalId })) },
    },
  });
  const createInput = {
    worldId,
    targetCityKey: initial.cities[1]!.cityKey,
    targetYear: initial.startYear + 1,
    targetMonth: 1,
    min: { crew: 100, train: 90, atmos: 90 },
    memberIds: [1, 2],
  };
  return { worldId, alice, bob, outsider, eve, sanctioned, operationId: operation.id, createInput };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function inputFor(route: Route, f: Fixture) {
  return route === 'operation.create'
    ? f.createInput
    : route === 'operation.list' || route === 'inspection.members'
      ? { worldId: f.worldId }
      : { worldId: f.worldId, id: f.operationId };
}
async function gameSnapshot(worldId: string) {
  return {
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    generals: await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    cities: await db.city.findMany({ where: { worldId }, orderBy: { cityKey: 'asc' } }),
    nations: await db.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    nationTurns: await db.nationTurn.findMany({ where: { worldId } }),
    inputs: await db.inputEvent.findMany({ where: { worldId } }),
    months: await db.yearbookSnapshot.findMany({ where: { worldId } }),
    hash: hashState(await db.$transaction((tx) => readView(tx, worldId))),
  };
}
beforeAll(async () => {
  initial = await readFixture();
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worldIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

const routes: Route[] = [
  'operation.create',
  'operation.list',
  'operation.get',
  'operation.suggest',
  'operation.close',
  'inspection.members',
];
describe.each(routes)('%s 실제 HTTP 권한', (route) => {
  for (const category of ['success', 'unauthenticated', 'otherUser', 'sanctioned', 'invalidInput'] as const) {
    it(
      category,
      authzCase(route, category, async () => {
        const f = await fixture();
        const input = inputFor(route, f);
        const cookie =
          category === 'unauthenticated'
            ? undefined
            : category === 'otherUser'
              ? f.outsider.cookie
              : category === 'sanctioned'
                ? f.sanctioned.cookie
                : f.alice.cookie;
        const response = await rpc(route, category === 'invalidInput' ? { ...input, actorId: 1 } : input, cookie);
        if (category === 'success') {
          expect(response.status).toBe(200);
          expect(response.data).toBeDefined();
        } else if (category === 'unauthenticated' || category === 'sanctioned')
          expect(response.error).toBe('UNAUTHORIZED');
        else if (category === 'invalidInput') expect(response.error).toBe('BAD_REQUEST');
        else if (route === 'operation.list') {
          expect(response.status).toBe(200);
          expect(response.data).toMatchObject({ items: [] });
        } else expect(response.error).toBe('FORBIDDEN');
      }),
    );
  }
});

it('만들기와 닫기는 보조 표만 바꾸고 게임 행·큐·해시·sequence를 보존한다', async () => {
  const f = await fixture();
  const before = await gameSnapshot(f.worldId);
  const created = await rpc('operation.create', f.createInput, f.alice.cookie);
  expect(created.status).toBe(200);
  expect(await gameSnapshot(f.worldId)).toEqual(before);
  expect(await db.operationMember.count({ where: { operationId: created.data!.id } })).toBe(2);
  const closed = await rpc('operation.close', { worldId: f.worldId, id: created.data!.id }, f.alice.cookie);
  expect(closed.data!.status).toBe('CLOSED');
  expect(await gameSnapshot(f.worldId)).toEqual(before);
  expect((await rpc('operation.close', { worldId: f.worldId, id: created.data!.id }, f.alice.cookie)).error).toBe(
    'PRECONDITION_FAILED',
  );
});

it('같은 작전의 참여자는 30칸 인자와 explicit을 보고 다른 국가와 없는 ID는 같은 거부를 받는다', async () => {
  const f = await fixture();
  await db.generalTurn.update({
    where: { worldId_generalId_slot: { worldId: f.worldId, generalId: 2, slot: 29 } },
    data: { commandKey: 'recruit', args: { crewType: 1100, amount: 37 } },
  });
  const response = await rpc('operation.get', { worldId: f.worldId, id: f.operationId }, f.bob.cookie);
  expect(response.data!.timeline).toHaveLength(2);
  expect(response.data!.timeline.find((member) => member.generalId === 2)!.cells[29]!.turn).toMatchObject({
    args: { amount: 37 },
    explicit: true,
  });
  expect(Object.keys(response.data!.target)).toEqual(['cityKey', 'cityName', 'nation']);
  expect((await rpc('operation.get', { worldId: f.worldId, id: f.operationId }, f.eve.cookie)).error).toBe('FORBIDDEN');
  expect((await rpc('operation.get', { worldId: f.worldId, id: randomUUID() }, f.alice.cookie)).error).toBe(
    'FORBIDDEN',
  );
  const other = await fixture();
  expect((await rpc('operation.get', { worldId: f.worldId, id: other.operationId }, f.alice.cookie)).error).toBe(
    'FORBIDDEN',
  );
});

it('국가를 떠난 참여자는 timeline과 집계에서 빠지고 저장 행은 남는다', async () => {
  const f = await fixture();
  await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 2 } }, data: { nationId: 2 } });
  const result = await rpc('operation.get', { worldId: f.worldId, id: f.operationId }, f.alice.cookie);
  expect(result.data!.timeline.map((member) => member.generalId)).toEqual([1]);
  expect(result.data!.members).toBe(1);
  expect(await db.operationMember.count({ where: { operationId: f.operationId } })).toBe(2);
  expect((await rpc('operation.get', { worldId: f.worldId, id: f.operationId }, f.bob.cookie)).error).toBe('FORBIDDEN');
});

it('직책 4는 생성과 감찰이 막히고 5는 허용하며 같은 국가 군주가 닫을 수 있다', async () => {
  const f = await fixture();
  await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { officerLevel: 4 } });
  expect((await rpc('operation.create', f.createInput, f.alice.cookie)).error).toBe('FORBIDDEN');
  expect((await rpc('inspection.members', { worldId: f.worldId }, f.alice.cookie)).error).toBe('FORBIDDEN');
  await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { officerLevel: 5 } });
  expect((await rpc('inspection.members', { worldId: f.worldId }, f.alice.cookie)).status).toBe(200);
  await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 4 } }, data: { officerLevel: 12 } });
  expect(
    (await rpc('operation.close', { worldId: f.worldId, id: f.operationId }, f.outsider.cookie)).data!.status,
  ).toBe('CLOSED');
});

it('지난달·잘못된 월·중복·다른 국가 참여자를 거부하고 현재월과 Int32 밖 목표는 받는다', async () => {
  const f = await fixture();
  for (const change of [
    { targetYear: initial.startYear - 1 },
    { targetMonth: 13 },
    { memberIds: [1, 1] },
    { memberIds: [3] },
    { targetCityKey: 2147483647 },
  ])
    expect((await rpc('operation.create', { ...f.createInput, ...change }, f.alice.cookie)).error).toBe('BAD_REQUEST');
  const current = await rpc(
    'operation.create',
    { ...f.createInput, targetYear: initial.startYear, targetMonth: 1 },
    f.alice.cookie,
  );
  expect(current.status).toBe(200);
  expect(
    (await rpc('operation.get', { worldId: f.worldId, id: current.data!.id }, f.alice.cookie)).data!.timeline.every(
      (member) => member.verdict === 'LATE' || member.verdict === 'MISSING',
    ),
  ).toBe(true);
  const far = await rpc('operation.create', { ...f.createInput, targetYear: 3_000_000_000 }, f.alice.cookie);
  expect(far.status).toBe(200);
  const detail = await rpc('operation.get', { worldId: f.worldId, id: far.data!.id }, f.alice.cookie);
  expect(detail.data!.targetDate.year).toBe(3_000_000_000);
  expect(detail.data!.targetTick).toBeGreaterThan(2147483647);
  expect(detail.data!.targetAt).toBeNull();
  expect(detail.data!.months.length).toBeLessThanOrEqual(31);
  expect(detail.data!.timeline.every((member) => member.beyondWindow)).toBe(true);
  expect(
    (await rpc('operation.suggest', { worldId: f.worldId, id: far.data!.id }, f.alice.cookie)).data!.noop!.code,
  ).toBe('BEYOND_WINDOW');
});

it('감찰은 legacy null과 NPC를 판정하지 않고 숫자 활동은 14일 경계를 지킨다', async () => {
  const f = await fixture();
  const threshold = (14 * 1440 * 10000) / 30;
  await db.world.update({ where: { id: f.worldId }, data: { status: 'PAUSED', clockTick: threshold } });
  let result = await rpc('inspection.members', { worldId: f.worldId }, f.alice.cookie);
  expect(result.data!.items.map((row) => row.generalId)).toEqual([1, 2, 4, 5]);
  expect(result.data!.items.every((row) => !row.idle)).toBe(true);
  await db.world.update({ where: { id: f.worldId }, data: { clockTick: threshold + 1 } });
  result = await rpc('inspection.members', { worldId: f.worldId }, f.alice.cookie);
  expect(result.data!.items.find((row) => row.generalId === 1)!.idle).toBe(true);
  expect(result.data!.items.find((row) => row.generalId === 5)!.idle).toBe(false);
  await db.world.update({ where: { id: f.worldId }, data: { status: 'ENDED', policyFromSequence: null } });
  await db.general.updateMany({
    where: { worldId: f.worldId },
    data: { lastActiveTick: null, lastActiveAt: null, defaultPolicy: null },
  });
  result = await rpc('inspection.members', { worldId: f.worldId }, f.alice.cookie);
  expect(result.status).toBe(200);
  expect(result.data!.items.every((row) => !row.idle && row.lastActiveAt === null && row.nextTurnAt === null)).toBe(
    true,
  );
});

it('제안은 explicit을 보존하고 저장된 30칸과 revision·활동·게임 상태를 바꾸지 않는다', async () => {
  const f = await fixture();
  await db.general.update({
    where: { worldId_id: { worldId: f.worldId, id: 1 } },
    data: { defaultPolicy: 'drill', train: 95, atmos: 90 },
  });
  await db.generalTurn.updateMany({ where: { worldId: f.worldId, generalId: 1 }, data: { explicit: false } });
  const before = await gameSnapshot(f.worldId);
  const result = await rpc('operation.suggest', { worldId: f.worldId, id: f.operationId }, f.alice.cookie);
  expect(result.status).toBe(200);
  expect(result.data!.revision).toBe(0);
  expect(result.data!.current.every((slot) => !slot.explicit)).toBe(true);
  expect(result.data!.slots[0]!.explicit).toBe(false);
  expect(result.data!.slots.filter((slot) => slot.commandKey === 'attack')).toHaveLength(1);
  expect(await gameSnapshot(f.worldId)).toEqual(before);
});

it('국가 FK Cascade는 멸망 때 작전 보조 행을 지우고 다른 세계는 건드리지 않는다', async () => {
  const f = await fixture(),
    other = await fixture();
  await db.general.updateMany({ where: { worldId: f.worldId, nationId: 1 }, data: { nationId: null } });
  await db.city.updateMany({ where: { worldId: f.worldId, nationId: 1 }, data: { nationId: null } });
  await db.nation.delete({ where: { worldId_id: { worldId: f.worldId, id: 1 } } });
  expect(await db.operation.count({ where: { worldId: f.worldId } })).toBe(0);
  expect(await db.operationMember.count({ where: { worldId: f.worldId } })).toBe(0);
  expect(await db.operation.count({ where: { worldId: other.worldId } })).toBe(1);
});

it('DB는 서로 다른 월드의 연결과 잘못된 목표·최소값을 거부한다', async () => {
  const f = await fixture(),
    other = await fixture();
  await expect(
    db.operationMember.create({ data: { worldId: other.worldId, operationId: f.operationId, generalId: 4 } }),
  ).rejects.toMatchObject({ code: 'P2003' });
  for (const tick of [-1n, 9007199254740992n]) {
    await expect(
      db.$executeRaw`UPDATE "Operation" SET "targetTick" = ${tick} WHERE id = ${f.operationId}`,
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
  }
  await expect(db.$executeRaw`UPDATE "Operation" SET "minCrew" = -1 WHERE id = ${f.operationId}`).rejects.toMatchObject(
    { code: 'P2010', meta: { code: '23514' } },
  );
});
