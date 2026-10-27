import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { FIVE_STAT_RULES, TICKS_PER_MONTH } from '../packages/rules/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';

// AC-INT-15 산식 연결 검사. 정식 491명 한 기수 인수는 INT-12에서 별도로 한다.
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)) throw Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const app = await buildServer({ db, logging: false });
const users = Array.from({ length: 5 }, () => randomUUID());
const worlds: string[] = [];
let worldId: string, otherWorld: string, legacyWorld: string, cookie: string, outsider: string;
const initial = commandInitial();
initial.statRules = { ...FIVE_STAT_RULES };
initial.ruleFeatures = ['five-stats', 'policy'];
initial.nations = initial.nations.map((row) => ({ ...row, isNpc: false }));
initial.generals = initial.generals.map((row, index) => ({
  ...row,
  userId: users[index]!,
  leadership: 55,
  strength: 35,
  intel: 50,
  politics: 90,
  charm: 45,
  crew: 1000,
  train: 20,
  atmos: 20,
  injury: 0,
  nextTurnTick: index === 0 ? 100 : 1000000,
}));
const commands = [
  'farm',
  'commerce',
  'research',
  'wall',
  'goodwill',
  'settle',
  'defence',
  'security',
  'recruit',
  'conscript',
  'train',
  'morale',
].map((commandKey) => ({
  commandKey,
  args: commandKey === 'recruit' || commandKey === 'conscript' ? { amount: 10, crewType: 1100 } : {},
}));

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
  await db.user.createMany({
    data: users.map((id) => ({ id, email: `${id}@example.invalid`, passwordHash: 'test-only' })),
  });
  for (const [index, userId] of users.entries()) {
    if (index !== 0 && index !== 4) continue;
    const session = newSession(Date.now());
    await db.session.create({ data: { id: session.id, userId, expiresAt: session.expiresAt } });
    if (index === 0) cookie = `sid=${session.token}`;
    else outsider = `sid=${session.token}`;
  }
  for (const value of [
    initial,
    initial,
    {
      ...commandInitial(),
      generals: commandInitial().generals.map((row, index) => ({ ...row, userId: users[index]! })),
    },
  ]) {
    const saved = await saveInitialWorld(db, value, { name: 'INT15 산식 연결', turnTermMinutes: 60, endYear: null });
    worlds.push(saved.worldId);
  }
  [worldId, otherWorld, legacyWorld] = worlds as [string, string, string];
  await controlClock(db, worldId, 'start');
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

it('INT-15 실제 세션 미리보기는 읽기 전용이고 타인·위조 행위자를 거부하며 구형 응답을 보존한다', async () => {
  const input = { worldId, commandKey: 'farm', args: {} };
  const before = await readWorldState(db, worldId);
  expect((await request('turns.precheck', input, '')).code).toBe('UNAUTHORIZED');
  expect((await request('turns.precheck', input, outsider)).code).toBe('NOT_FOUND');
  expect((await request('turns.precheck', { ...input, generalId: 2 })).code).toBe('BAD_REQUEST');
  for (let i = 0; i < 2; i++)
    expect((await request('turns.precheck', input)).data).toMatchObject({ ok: true, preview: { statScore: 90 } });
  expect(await readWorldState(db, worldId)).toEqual(before);
  expect(await db.inputEvent.count({ where: { worldId } })).toBe(0);
  expect((await request('turns.precheck', { ...input, worldId: legacyWorld })).data).toEqual({ ok: true });
});

it('INT-15 12종 실행·빈칸 방침·명시적 휴식·재접속·동일 시드 재생이 일치한다', async () => {
  const slots = [
    ...commands,
    { commandKey: 'rest', args: {} },
    ...Array.from({ length: 29 - commands.length }, () => null),
  ];
  expect((await request('turns.set', { worldId, revision: 0, slots }, cookie, true)).data).toMatchObject({ ok: true });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('시험 엔진 리스가 없습니다.');
  try {
    const loop = new TurnLoop(db, lease);
    for (const [index, command] of commands.entries()) {
      await renewLease(db, lease);
      const tick = 100 + index * TICKS_PER_MONTH;
      await loop.advanceTo(tick - 1);
      const before = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
      const preview = (await request('turns.precheck', { worldId, ...command })).data;
      expect(preview.ok).toBe(true);
      await loop.advanceTo(tick);
      const after = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
      expect(before.gold - after.gold).toBe(preview.preview.goldCost);
      if (command.commandKey === 'train') expect(after.train - before.train).toBe(preview.preview.gain);
      if (command.commandKey === 'morale') expect(after.atmos - before.atmos).toBe(preview.preview.gain);
      expect(after.turnRevision).toBe(before.turnRevision + 1);
    }
    await loop.advanceTo(12 * TICKS_PER_MONTH);
    const policy = async (value: string, tick: number) => {
      const response = request('general.setPolicy', { worldId, policy: value }, cookie, true);
      await expect
        .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.setPolicy', status: 'PENDING' } }))
        .toBe(1);
      await loop.advanceTo(tick);
      expect((await response).data).toMatchObject({ status: 'applied', policy: { current: value } });
    };
    const general = () => db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    await policy('farm', 120000);
    const resting = await general();
    expect(await loop.advanceTo(120100)).toEqual([{ generalId: 1, tick: 120100, commandKey: 'rest' }]);
    expect((await general()).gold).toBe(resting.gold);
    await loop.advanceTo(130099);
    const farming = await general();
    const farmPreview = (await request('turns.precheck', { worldId, commandKey: 'farm', args: {} })).data.preview;
    expect(farmPreview.statScore).toBe(90);
    expect(await loop.advanceTo(130100)).toEqual([{ generalId: 1, tick: 130100, commandKey: 'farm' }]);
    expect(farming.gold - (await general()).gold).toBe(farmPreview.goldCost);
    await policy('drill', 130100);
    await loop.advanceTo(140099);
    const training = await general();
    const drillPreview = (await request('turns.precheck', { worldId, commandKey: 'train', args: {} })).data.preview;
    expect(await loop.advanceTo(140100)).toEqual([{ generalId: 1, tick: 140100, commandKey: 'train' }]);
    expect((await general()).train - training.train).toBe(drillPreview.gain);
    await loop.advanceTo(15 * TICKS_PER_MONTH);
  } finally {
    await releaseLease(db, lease);
  }
  const reopened = createDb(url!);
  try {
    const archive = await exportReplay(reopened, worldId);
    const first = replayArchive(archive, 15);
    expect(replayArchive(archive, 15)).toEqual(first);
    expect(first.at(-1)!.stateHash).toBe(hashState(await reopened.$transaction((tx) => loadReplayState(tx, worldId))));
  } finally {
    await reopened.$disconnect();
  }
  expect(await readWorldState(db, otherWorld)).toEqual(initial);
});
