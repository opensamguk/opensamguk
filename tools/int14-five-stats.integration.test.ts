import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { FIVE_STAT_RULES, TICKS_PER_MONTH, type WorldInit } from '../packages/rules/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { exportReplay, readArchive, replayArchive } from '../apps/engine/src/replay';

// AC-INT-14만 검증하는 작은 고정물이다. 정식491명·전체 기수 인수는 INT-12다.
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const app = await buildServer({ db, logging: false });
const worlds: string[] = [],
  users: string[] = [];
let address: string, worldId: string, otherWorld: string, legacyWorld: string;
let cookie: string, outsiderCookie: string, actor: string;
const payload = {
  name: '오능력시험',
  leadership: 55,
  strength: 55,
  intel: 55,
  politics: 55,
  charm: 55,
  portraitId: null,
};
const initial = commandInitial();
initial.statRules = { ...FIVE_STAT_RULES };
initial.ruleFeatures = ['five-stats', 'personnel', 'policy'];
initial.generals = initial.generals.map((g) => ({ ...g, politics: 0, charm: 100 }));

async function identity() {
  const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, passwordHash: 'test-only' } });
  users.push(user.id);
  const session = newSession(Date.now());
  await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
  return { id: user.id, cookie: `sid=${session.token}` };
}
async function request(path: string, input: unknown, session?: string, mutation = false) {
  const response = await fetch(
    `${address}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin: 'http://127.0.0.1:5173',
        ...(session ? { cookie: session } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: JSON.stringify({ 0: input }) } : {}),
    },
  );
  const [body] = await response.json();
  return { data: body.result?.data, code: body.error?.data?.code };
}
async function save(value: WorldInit) {
  const saved = await saveInitialWorld(db, value, { name: 'INT14 계약 시험', turnTermMinutes: 60, endYear: null });
  worlds.push(saved.worldId);
  return saved;
}
beforeAll(async () => {
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  ({ worldId } = await save(initial));
  otherWorld = (await save(initial)).worldId;
  legacyWorld = (await save(commandInitial())).worldId;
  ({ id: actor, cookie } = await identity());
  outsiderCookie = (await identity()).cookie;
  await controlClock(db, worldId, 'start');
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

it('INT-14 동일 시드·새 판 0/100·구형 null과 해시를 보존한다', async () => {
  expect(await readWorldState(db, worldId)).toEqual(initial);
  expect(hashState(await readWorldState(db, otherWorld))).toBe(hashState(initial));
  expect(await readWorldState(db, legacyWorld)).toEqual(commandInitial());
  const old = await db.general.findFirstOrThrow({ where: { worldId: legacyWorld } });
  expect([old.politics, old.charm]).toEqual([null, null]);
  for (const data of [{ politics: 101 }, { politics: null }, { charm: -1 }])
    await expect(db.general.update({ where: { worldId_id: { worldId, id: 1 } }, data })).rejects.toThrow();
  expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).politics).toBe(0);
});
it('INT-14 실제 HTTP의 5값·세션 행위자·추가 필드·합계·누락을 검사한다', async () => {
  expect((await request('general.create', { worldId, ...payload }, undefined, true)).code).toBe('UNAUTHORIZED');
  for (const patch of [{ charm: null }, { politics: 56 }, { intelligence: 55 }, { userId: actor }])
    expect((await request('general.create', { worldId, ...payload, ...patch }, cookie, true)).code).toBe('BAD_REQUEST');
  const missing = { ...payload } as Partial<typeof payload>;
  delete missing.politics;
  expect((await request('general.create', { worldId, ...missing }, cookie, true)).code).toBe('BAD_REQUEST');
  expect(await db.inputEvent.count({ where: { worldId } })).toBe(0);
});
it('INT-14 중복 접수는 한 입력이며 엔진 생성·조회·재접속·월 정산·재생의 5값이 같다', async () => {
  const responses = await Promise.all([
    request('general.create', { worldId, ...payload }, cookie, true),
    request('general.create', { worldId, ...payload }, cookie, true),
  ]);
  expect(responses.map((r) => r.data?.status)).toEqual(['pending', 'pending']);
  expect(await db.inputEvent.count({ where: { worldId, kind: 'general.create' } })).toBe(1);
  const lease = await acquireLease(db, worldId);
  expect(lease).not.toBeNull();
  try {
    const loop = new TurnLoop(db, lease!);
    await loop.advanceTo(0);
    const mine = await request('general.mine', { worldId }, cookie);
    expect(mine.data.general).toMatchObject(payload);
    expect(mine.data.general).not.toHaveProperty('userId');
    expect((await request('general.mine', { worldId }, outsiderCookie)).data.general).toBeNull();
    expect((await request('general.create', { worldId, ...payload }, cookie, true)).code).toBe('CONFLICT');
    expect(await db.general.count({ where: { worldId, userId: actor } })).toBe(1);
    await loop.advanceTo(TICKS_PER_MONTH);
  } finally {
    await releaseLease(db, lease!);
  }
  const reopened = createDb(url!);
  try {
    expect(await reopened.$transaction((tx) => loadWorld(tx, worldId))).toEqual(
      await db.$transaction((tx) => loadWorld(tx, worldId)),
    );
    expect((await readWorldState(reopened, worldId)).generals.find((g) => g.userId === actor)).toMatchObject(payload);
    const archive = await exportReplay(reopened, worldId);
    expect(archive.version).toBe(3);
    const replay = replayArchive(archive, 1);
    expect(replay[0]!.stateHash).toBe(hashState(await reopened.$transaction((tx) => loadReplayState(tx, worldId))));
    const forged = structuredClone(archive);
    (forged.inputs[0]!.result as { general: { politics: number } }).general.politics = 56;
    expect(() => readArchive(forged)).toThrow();
  } finally {
    await reopened.$disconnect();
  }
  expect(hashState(await readWorldState(db, otherWorld))).toBe(hashState(initial));
  expect(await readWorldState(db, legacyWorld)).toEqual(commandInitial());
});
