import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { appRouter } from '../apps/server/src/router';
import { newSession } from '../apps/server/src/auth/session';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { rngFor } from '../packages/shared/src/index';
import { defaultOfficeEffects, residentOfficeBonuses, runMonthly } from '../packages/rules/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worlds: string[] = [];
const users: string[] = [];
const now = Date.now();
const app = await buildServer({ db, now: () => now, logging: false });
let address: string;
type Actor = { id: string; cookie: string };

beforeAll(async () => {
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
}, 60_000);
async function identity(role: 'ADMIN' | 'USER' = 'USER', status: 'ACTIVE' | 'SANCTIONED' = 'ACTIVE'): Promise<Actor> {
  const user = await db.user.create({
    data: {
      email: randomUUID() + '@example.test',
      passwordHash: 'fixture-only',
      emailVerifiedAt: new Date(now),
      role,
      status,
    },
  });
  users.push(user.id);
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
  return { id: user.id, cookie: 'sid=' + session.token };
}
async function call(path: string, input: unknown, actor?: Actor) {
  const mutation = appRouter._def.procedures[path]?._def.type === 'mutation';
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    address + '/trpc/' + path + '?batch=1' + (mutation ? '' : '&input=' + encodeURIComponent(encoded)),
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin: 'http://127.0.0.1:5173',
        ...(actor ? { cookie: actor.cookie } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: encoded } : {}),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = (await response.json())[0] as { result?: { data: unknown }; error?: { data: { code: string } } };
  return { status: response.status, data: body.result?.data, code: body.error?.data.code };
}
async function advance(worldId: string, tick: number) {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('자기 시험 월드의 실행권을 얻지 못했습니다.');
  try {
    await new TurnLoop(db, lease, { beforeCommit: (tx) => renewLease(tx, lease) }).advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}
async function applyQueued(worldId: string, kind: string, waiting: Promise<unknown>) {
  try {
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, kind, status: 'PENDING' } }), { timeout: 10000 })
      .toBe(1);
  } catch (cause) {
    throw new Error('입력 접수를 확인하지 못했습니다. ' + JSON.stringify(await waiting), { cause });
  }
  const world = await db.world.findUniqueOrThrow({ where: { id: worldId }, select: { clockTick: true } });
  await advance(worldId, world.clockTick);
  return waiting;
}
async function claim(worldId: string, generalId: number, actor: Actor) {
  const input = { worldId, generalId, expectedUserId: actor.id, idempotencyKey: randomUUID() };
  const response = await applyQueued(worldId, 'general.possess', call('entry.possess', input, actor));
  expect(response).toMatchObject({ status: 200 });
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: generalId } } })).toMatchObject({
    userId: actor.id,
  });
}
async function createWorld(capture = false) {
  const initial = commandInitial();
  const base = initial.generals[2]!;
  Object.assign(base, { nationId: 1, cityKey: 1, strength: 65, intel: 65 });
  initial.generals.push(
    { ...base, id: 5, name: '초대태수' },
    { ...base, id: 6, name: '군사후보' },
    { ...base, id: 7, name: '미달후보', strength: 64, intel: 64 },
  );
  for (const general of initial.generals) if (general.id !== 3) general.nextTurnTick = 10000;
  initial.cities[0]!.connections.push(4);
  initial.cities[3]!.connections.push(1);
  if (capture) {
    Object.assign(initial.cities[3]!, { nationId: 2 });
    Object.assign(initial.generals[0]!, { nextTurnTick: 100 });
    Object.assign(initial.generals[1]!, { cityKey: 4 });
    Object.assign(base, { cityKey: 4, nationId: 2, nextTurnTick: 10000 });
  } else {
    initial.diplomacies = [];
  }
  initial.ruleFeatures = ['office-effects', 'personnel', 'policy'];
  const { worldId } = await saveInitialWorld(db, initial, { name: '주재 검증', turnTermMinutes: 60, endYear: 230 });
  worlds.push(worldId);
  await controlClock(db, worldId, 'start');
  return worldId;
}

async function enableClaims(worldId: string, operator: Actor) {
  expect(
    await call(
      'admin.world.requestSetting',
      {
        worldId,
        expectedUserId: operator.id,
        idempotencyKey: randomUUID(),
        reason: '주재 검증 장수 맡기',
        setting: { kind: 'admin.world.setOption', key: 'entry.npcPlay', value: 'on' },
      },
      operator,
    ),
  ).toMatchObject({ status: 200 });
  await advance(worldId, 0);
}

it('AC-M3-12 실제 HTTP 임명·교체·이동·해임과 12개월 정산 해시가 일치한다', async () => {
  const operator = await identity('ADMIN'),
    ruler = await identity(),
    governor = await identity(),
    military = await identity(),
    viewer = await identity(),
    sanctioned = await identity('USER', 'SANCTIONED');
  const worldId = await createWorld();
  const original = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect(original.officeEffects).toEqual(defaultOfficeEffects);
  expect(original.replayOrigin).toMatchObject({ featureData: { 'office-effects': defaultOfficeEffects } });
  await enableClaims(worldId, operator);
  await claim(worldId, 1, ruler);
  await claim(worldId, 3, governor);
  await claim(worldId, 6, military);
  const appointment = (generalId: number, officerLevel = 4, cityKey = 1, expectedHolderId: number | null = null) => ({
    worldId,
    requestId: randomUUID(),
    generalId,
    officerLevel,
    cityKey,
    expectedHolderId,
  });
  expect(await call('personnel.appoint', appointment(5))).toMatchObject({ code: 'UNAUTHORIZED' });
  expect(await call('personnel.appoint', appointment(5), governor)).toMatchObject({ code: 'FORBIDDEN' });
  expect(await call('personnel.appoint', appointment(5), sanctioned)).toMatchObject({ code: 'UNAUTHORIZED' });
  expect(await call('personnel.appoint', appointment(7), ruler)).toMatchObject({ code: 'BAD_REQUEST' });
  expect(await call('personnel.appoint', appointment(7, 3), ruler)).toMatchObject({ code: 'BAD_REQUEST' });
  expect(await call('personnel.appoint', appointment(5, 4, 2), ruler)).toMatchObject({ code: 'BAD_REQUEST' });
  expect(await call('personnel.appoint', appointment(2), ruler)).toMatchObject({ code: 'BAD_REQUEST' });
  const { cityKey: omitted, ...withoutCity } = appointment(5);
  expect(omitted).toBe(1);
  expect(await call('personnel.appoint', withoutCity, ruler)).toMatchObject({ code: 'BAD_REQUEST' });
  expect(await call('personnel.appoint', appointment(5, 11), ruler)).toMatchObject({ code: 'BAD_REQUEST' });
  expect(await db.inputEvent.count({ where: { worldId, kind: 'personnel.appoint' } })).toBe(0);
  const appoint = (input: ReturnType<typeof appointment>) =>
    applyQueued(worldId, 'personnel.appoint', call('personnel.appoint', input, ruler));
  expect(await appoint(appointment(5))).toMatchObject({
    data: { result: { generalId: 5, officerLevel: 4, officerCityKey: 1 } },
  });
  expect(await call('personnel.appoint', appointment(3), ruler)).toMatchObject({ code: 'CONFLICT' });
  expect(await appoint(appointment(3, 4, 1, 5))).toMatchObject({ data: { result: { generalId: 3, officerLevel: 4 } } });
  expect(await appoint(appointment(6, 3))).toMatchObject({ data: { result: { generalId: 6, officerLevel: 3 } } });
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 5 } } })).toMatchObject({
    officerLevel: 1,
    officerCityKey: null,
  });
  expect(await call('personnel.officers', { worldId }, ruler)).toMatchObject({
    data: {
      officeEffectsEnabled: true,
      officeCities: expect.arrayContaining([{ cityKey: 1, name: '도시1' }]),
      members: expect.arrayContaining([expect.objectContaining({ generalId: 3, officerCityKey: 1, resident: true })]),
    },
  });
  const city = () => call('city.get', { worldId, cityKey: 1 }, viewer);
  expect(await city()).toMatchObject({
    data: {
      officers: [
        { generalId: 3, name: '장수3', officerLevel: 4, resident: true },
        { generalId: 6, name: '군사후보', officerLevel: 3, resident: true },
      ],
    },
  });
  const general = () => db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } });
  await expect(
    db.general.update({
      where: { worldId_id: { worldId, id: 5 } },
      data: { officerLevel: 4, officerCityKey: 1 },
    }),
  ).rejects.toMatchObject({ code: 'P2002' });
  expect(
    await call(
      'turns.edit',
      {
        worldId,
        revision: (await general()).turnRevision,
        op: { put: { from: 0, to: 0, commandKey: 'move', args: { cityKey: 4 } } },
      },
      governor,
    ),
  ).toMatchObject({ status: 200 });
  const officer = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 6 } } });
  expect(
    await call(
      'turns.edit',
      {
        worldId,
        revision: officer.turnRevision,
        op: { put: { from: 0, to: 0, commandKey: 'rest', args: {} } },
      },
      military,
    ),
  ).toMatchObject({ status: 200, code: undefined });
  await advance(worldId, 9999);
  const beforeMonth = await db.$transaction((tx) => loadWorld(tx, worldId));
  expect(beforeMonth.cities[1]).toMatchObject({ nationId: 1, commerce: 100, population: 20000 });
  expect(runMonthly(beforeMonth, 10000, rngFor('war-contract', 'monthly', 191, 1)).officeTaxLogs).toEqual([
    { generalId: 6, text: '도시1 주재로 세수 10% 보정' },
  ]);
  await advance(worldId, 10000);
  const militaryState = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 6 } } });
  expect(militaryState).toMatchObject({ cityKey: 1, officerCityKey: 1, officerLevel: 3, activeFromYear: 175 });
  const settledWorld = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect(settledWorld).toMatchObject({ monthlyTick: 10000, status: 'RUNNING' });
  const monthlyState = await db.$transaction((tx) => loadWorld(tx, worldId));
  expect(monthlyState.cities[1]).toMatchObject({
    nationId: 1,
    commerce: expect.any(Number),
    population: expect.any(Number),
  });
  expect(residentOfficeBonuses(monthlyState, 191).get(1)).toMatchObject({ tax: { percent: 10, generalId: 6 } });
  expect(await general()).toMatchObject({ cityKey: 4, officerCityKey: 1 });
  expect(await city()).toMatchObject({
    data: {
      officers: expect.arrayContaining([expect.objectContaining({ generalId: 3, officerLevel: 4, resident: false })]),
    },
  });
  expect(
    await db.generalLog.findMany({
      where: { worldId, tick: 10000, commandKey: 'office.residence' },
      select: { generalId: true, text: true },
    }),
  ).toEqual([{ generalId: 6, text: '도시1 주재로 세수 10% 보정' }]);
  const dismiss = call('personnel.dismiss', { worldId, generalId: 6, requestId: randomUUID() }, ruler);
  expect(await applyQueued(worldId, 'personnel.dismiss', dismiss)).toMatchObject({ status: 200 });
  expect(
    await call(
      'turns.edit',
      {
        worldId,
        revision: (await general()).turnRevision,
        op: { put: { from: 0, to: 0, commandKey: 'resign', args: {} } },
      },
      governor,
    ),
  ).toMatchObject({ status: 200 });
  await advance(worldId, 120000);
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } })).toMatchObject({
    officerCityKey: null,
    officerLevel: 0,
    nationId: null,
  });
  const snapshots = await db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } });
  expect(snapshots).toHaveLength(12);
  expect(replayArchive(await exportReplay(db, worldId), 12).map(({ stateHash }) => stateHash)).toEqual(
    snapshots.map(({ stateHash }) => stateHash),
  );
  expect(await db.$transaction((tx) => loadWorld(tx, worldId))).toMatchObject({ officeEffects: defaultOfficeEffects });
}, 100_000);

it('AC-M3-12 PostgreSQL 전투가 담당 도시를 빼앗으면 같은 장수 턴에서 해제한다', async () => {
  const operator = await identity('ADMIN'),
    attacker = await identity(),
    defender = await identity();
  const worldId = await createWorld(true);
  await enableClaims(worldId, operator);
  await claim(worldId, 1, attacker);
  await claim(worldId, 2, defender);
  const pending = call(
    'personnel.appoint',
    {
      worldId,
      requestId: randomUUID(),
      generalId: 3,
      officerLevel: 4,
      cityKey: 2,
      expectedHolderId: null,
    },
    defender,
  );
  expect(await applyQueued(worldId, 'personnel.appoint', pending)).toMatchObject({ data: { status: 'applied' } });
  const current = () => db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } });
  expect(await current()).toMatchObject({ officerCityKey: 2, officerLevel: 4, cityKey: 4, nationId: 2 });
  const ruler = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
  expect(
    await call(
      'turns.edit',
      {
        worldId,
        revision: ruler.turnRevision,
        op: { put: { from: 0, to: 0, commandKey: 'attack', args: { cityKey: 2 } } },
      },
      attacker,
    ),
  ).toMatchObject({ status: 200, code: undefined });
  await advance(worldId, 100);
  expect(await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 2 } } })).toMatchObject({
    nationId: 1,
  });
  expect(await current()).toMatchObject({ officerCityKey: null, officerLevel: 1, cityKey: 4, nationId: 2 });
  expect(await call('city.get', { worldId, cityKey: 2 }, attacker)).toMatchObject({ data: { officers: [] } });
});
