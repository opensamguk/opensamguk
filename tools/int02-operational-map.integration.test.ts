import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildInitialWorld, TICKS_PER_MONTH } from '../packages/rules/src/index';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';

// AC-INT-02 저장 어댑터 검사. 정식 53도시·191년 시나리오 인수는 INT-03/04/12다.
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)) throw Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const app = await buildServer({ db, logging: false });
const userId = randomUUID(),
  worlds: string[] = [];
const ownedUsers = [userId];
let cookie: string, worldId: string, legacyWorld: string;
const initial = buildInitialWorld(operationalInput());
initial.ruleFeatures!.push('policy');
let legacy: Awaited<ReturnType<typeof loadInitialWorldFromDb>>;

async function request(path: string, input: unknown, session = cookie, mutation = false) {
  const response = await app.inject({
    method: mutation ? 'POST' : 'GET',
    url: `/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`}`,
    headers: {
      origin: 'http://127.0.0.1:5173',
      ...(session ? { cookie: session } : {}),
      ...(mutation ? { 'content-type': 'application/json' } : {}),
    },
    ...(mutation ? { payload: JSON.stringify({ 0: input }) } : {}),
  });
  const [body] = response.json();
  return { data: body.result?.data, code: body.error?.data?.code };
}
beforeAll(async () => {
  await db.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'test-only' } });
  const session = newSession(Date.now());
  await db.session.create({ data: { id: session.id, userId, expiresAt: session.expiresAt } });
  cookie = `sid=${session.token}`;
  legacy = await loadInitialWorldFromDb(db, { scenario: '1030', map: 'che', seed: 'int02-legacy-preserved' });
  for (const value of [initial, legacy]) {
    const saved = await saveInitialWorld(db, value, { name: 'INT02 저장 계약', turnTermMinutes: 60, endYear: null });
    worlds.push(saved.worldId);
  }
  [worldId, legacyWorld] = worlds as [string, string];
  await controlClock(db, worldId, 'start');
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: ownedUsers } } });
  await db.$disconnect();
});

it('INT-02 실제 DB·API는 세 전략 앵커와 시설/표시를 분리하고 옛 월드를 보존한다', async () => {
  expect(await readWorldState(db, worldId)).toEqual(initial);
  expect(await db.city.count({ where: { worldId } })).toBe(3);
  expect(await db.city.count({ where: { worldId, kind: 'PASS', population: 0, agriculture: 0, commerce: 0 } })).toBe(1);
  expect((await request('world.map', { worldId }, '')).code).toBe('UNAUTHORIZED');
  expect((await request('world.map', { worldId: randomUUID() })).code).toBe('NOT_FOUND');
  const response = (await request('world.map', { worldId })).data;
  expect(response.cities.map((city: { key: number; kind: string }) => [city.key, city.kind])).toEqual([
    [1, 'CITY'],
    [2, 'CITY'],
    [99, 'PASS'],
  ]);
  expect(response.operationalMap.sites).toHaveLength(5);
  expect(response.operationalMap.sites.every((site: object) => !('initial' in site) && !('max' in site))).toBe(true);
  expect((await request('world.map', { worldId: legacyWorld })).data.operationalMap).toBeUndefined();
  expect(await readWorldState(db, legacyWorld)).toEqual(legacy);
  expect(await db.city.count({ where: { worldId: legacyWorld, kind: { not: null } } })).toBe(0);
});

it('INT-02 새 장수는 도시에서 생성되고 월간 정산·재시작·동일 시드 재생이 같다', async () => {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('시험 엔진 리스가 없습니다.');
  try {
    const creating = request(
      'general.create',
      { worldId, name: '지도검사', portraitId: null, leadership: 55, strength: 55, intel: 55, politics: 55, charm: 55 },
      cookie,
      true,
    );
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
      .toBe(1);
    await new TurnLoop(db, lease).advanceTo(0);
    expect((await creating).data).toMatchObject({ status: 'created' });
    const actor = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId } } });
    expect([1, 2]).toContain(actor.cityKey);
    await new TurnLoop(db, lease).advanceTo(TICKS_PER_MONTH);
    expect(await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 99 } } })).toMatchObject({
      kind: 'PASS',
      population: 0,
      agriculture: 0,
      commerce: 0,
    });
  } finally {
    await releaseLease(db, lease);
  }
  const reopened = createDb(url!);
  try {
    const archive = await exportReplay(reopened, worldId);
    const first = replayArchive(archive, 1);
    expect(replayArchive(archive, 1)).toEqual(first);
    expect(first.at(-1)!.stateHash).toBe(hashState(await reopened.$transaction((tx) => loadReplayState(tx, worldId))));
    expect((await reopened.$transaction((tx) => loadWorld(tx, worldId))).cities[99]!.kind).toBe('PASS');
  } finally {
    await reopened.$disconnect();
  }
  expect(await readWorldState(db, legacyWorld)).toEqual(legacy);
});

it('INT-02 DB의 잘못된 종류와 기능 판을 거부하고 생성 원장 변조를 감지한다', async () => {
  await expect(
    db.city.update({ where: { worldId_cityKey: { worldId, cityKey: 99 } }, data: { kind: 'PORT' } }),
  ).rejects.toThrow();
  await expect(
    db.world.update({ where: { id: worldId }, data: { ruleFeatures: ['five-stats', 'policy'] } }),
  ).rejects.toThrow();
  const map = structuredClone(initial.operationalMap!);
  map.sites[0]!.position.x++;
  await db.world.update({ where: { id: worldId }, data: { operationalMap: map } });
  try {
    await expect(db.$transaction((tx) => loadWorld(tx, worldId))).rejects.toThrow('생성 기록');
  } finally {
    await db.world.update({ where: { id: worldId }, data: { operationalMap: initial.operationalMap! } });
  }
});

it('INT-02 실제 조약 견적·목록·수락 비용과 국가 표시에서 관문을 도시로 세지 않는다', async () => {
  const users = [randomUUID(), randomUUID()];
  ownedUsers.push(...users);
  const sessions: string[] = [];
  for (const id of users) {
    await db.user.create({ data: { id, email: `${id}@example.invalid`, passwordHash: 'test-only' } });
    const session = newSession(Date.now());
    await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
    sessions.push(`sid=${session.token}`);
  }
  const value = buildInitialWorld(operationalInput());
  value.ruleFeatures!.push('policy', 'treaty');
  value.nations.forEach((nation) => {
    nation.isNpc = false;
    nation.gold = 100;
  });
  value.generals.forEach((general, index) => {
    general.userId = users[index]!;
    Object.assign(general, { leadership: 55, strength: 55, intel: 55, politics: 55, charm: 55 });
  });
  const saved = await saveInitialWorld(db, value, { name: 'INT02 관문 제외 조약', turnTermMinutes: 60, endYear: null });
  const id = saved.worldId;
  worlds.push(id);
  await controlClock(db, id, 'start');
  const lease = await acquireLease(db, id);
  if (!lease) throw Error('시험 엔진 리스가 없습니다.');
  try {
    expect((await request('home.get', { worldId: id }, sessions[0])).data.nation.cityCount).toBe(1);
    expect((await request('nation.get', { worldId: id, nationId: 1 }, sessions[0])).data.cityCount).toBe(1);
    const clauses = [{ kind: 'nonAggression', months: 12 }];
    expect((await request('treaty.quote', { worldId: id, toNationId: 2, clauses }, sessions[0])).data).toEqual({
      cost: { mine: 100, theirs: 100 },
      problem: null,
    });
    const proposal = request(
      'treaty.propose',
      { worldId: id, requestId: randomUUID(), toNationId: 2, clauses },
      sessions[0],
      true,
    );
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId: id, kind: 'treaty.propose', status: 'PENDING' } }))
      .toBe(1);
    const loop = new TurnLoop(db, lease);
    await loop.advanceTo(0);
    expect((await proposal).data).toMatchObject({ status: 'applied' });
    const treaty = await db.treaty.findFirstOrThrow({ where: { worldId: id } });
    const list = (await request('treaty.list', { worldId: id }, sessions[1])).data;
    expect(list.items[0]).toMatchObject({ estimate: { mine: 100, theirs: 100 }, canAccept: { ok: true } });
    const response = request(
      'treaty.respond',
      { worldId: id, requestId: randomUUID(), treatyId: String(treaty.id), accept: true },
      sessions[1],
      true,
    );
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId: id, kind: 'treaty.respond', status: 'PENDING' } }))
      .toBe(1);
    await loop.advanceTo(0);
    expect((await response).data).toMatchObject({ status: 'applied' });
    expect(
      (await db.nation.findMany({ where: { worldId: id }, orderBy: { id: 'asc' } })).map((nation) => nation.gold),
    ).toEqual([0, 0]);
    expect(await db.treaty.findFirstOrThrow({ where: { worldId: id } })).toMatchObject({
      costFrom: 100,
      costTo: 100,
      status: 'ACTIVE',
    });
  } finally {
    await releaseLease(db, lease);
  }
});
