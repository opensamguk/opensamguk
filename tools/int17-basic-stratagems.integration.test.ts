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

// AC-INT-17 명령 어댑터 검사. 정식 시나리오·지도·한 기수 인수를 대신하지 않는다.
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)) throw Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const app = await buildServer({ db, logging: false });
const users = Array.from({ length: 5 }, () => randomUUID());
const worlds: string[] = [];
let worldId: string, otherWorld: string, cookie: string, outsider: string;
let generalId: number, firstTick: number;
const initial = commandInitial();
initial.statRules = { ...FIVE_STAT_RULES };
initial.ruleFeatures = ['five-stats', 'personnel', 'policy', 'stratagem-basic', 'treaty'];
initial.nations = initial.nations.map((nation) => ({ ...nation, isNpc: false }));
initial.generals = initial.generals.map((general) => ({
  ...general,
  userId: null,
  leadership: 55,
  strength: 70,
  intel: 80,
  politics: 35,
  charm: 35,
  gold: 10000,
  rice: 10000,
  injury: 0,
  nextTurnTick: 1000000,
}));
const commands = ['fire_attack', 'sabotage', 'incite', 'plunder'].map((commandKey) => ({
  commandKey,
  args: { cityKey: 2 },
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
  for (let count = 0; count < 2; count++) {
    const saved = await saveInitialWorld(db, initial, {
      name: 'INT17 기본 계략 공존',
      turnTermMinutes: 60,
      endYear: null,
    });
    worlds.push(saved.worldId);
  }
  [worldId, otherWorld] = worlds as [string, string];
  await controlClock(db, worldId, 'start');
  await app.ready();
});

async function createHuman() {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('시험 엔진 리스가 없습니다.');
  try {
    const creating = request(
      'general.create',
      {
        worldId,
        name: '계략검사',
        portraitId: null,
        leadership: 55,
        strength: 70,
        intel: 80,
        politics: 35,
        charm: 35,
      },
      cookie,
      true,
    );
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
      .toBe(1);
    const loop = new TurnLoop(db, lease);
    await loop.advanceTo(0);
    expect((await creating).data).toMatchObject({ status: 'created' });
    const general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: users[0]! } } });
    generalId = general.id;
    expect(
      (
        await request(
          'turns.set',
          {
            worldId,
            revision: 0,
            slots: [{ commandKey: 'join', args: { nationId: 1 } }, ...Array.from({ length: 29 }, () => null)],
          },
          cookie,
          true,
        )
      ).data,
    ).toMatchObject({ ok: true });
    expect(await loop.advanceTo(general.nextTurnTick)).toEqual([
      { generalId, tick: general.nextTurnTick, commandKey: 'join' },
    ]);
    firstTick = general.nextTurnTick + TICKS_PER_MONTH;
  } finally {
    await releaseLease(db, lease);
  }
}
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

it('INT-17 실제 세션의 네 계략 검사·권한·중복 예약·재시작·재생이 공존한다', async () => {
  await createHuman();
  const before = await readWorldState(db, worldId);
  const first = { worldId, ...commands[0]! };
  expect((await request('turns.precheck', first, '')).code).toBe('UNAUTHORIZED');
  expect((await request('turns.precheck', first, outsider)).code).toBe('NOT_FOUND');
  expect((await request('turns.precheck', { ...first, generalId: 2 })).code).toBe('BAD_REQUEST');
  for (const command of commands)
    expect((await request('turns.precheck', { worldId, ...command })).data).toMatchObject({ ok: true });
  expect(await readWorldState(db, worldId)).toEqual(before);
  const slots = [...commands, ...Array.from({ length: 26 }, () => null)];
  const actorBefore = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: generalId } } });
  const save = { worldId, revision: actorBefore.turnRevision, slots };
  expect((await request('turns.set', save, cookie, true)).data).toMatchObject({ ok: true });
  expect((await request('turns.set', save, cookie, true)).data).toMatchObject({ ok: false, reason: 'STALE' });
  await db.user.update({ where: { id: users[0]! }, data: { status: 'SANCTIONED' } });
  expect((await request('turns.set', { ...save, revision: save.revision + 1 }, cookie, true)).code).toBe(
    'UNAUTHORIZED',
  );
  await db.user.update({ where: { id: users[0]! }, data: { status: 'ACTIVE' } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('시험 엔진 리스가 없습니다.');
  try {
    for (const [index, command] of commands.entries()) {
      await renewLease(db, lease);
      // 새 TurnLoop가 매번 DB에서 읽는다. 메모리의 이전 실행 결과에 의존하지 않는다.
      const loop = new TurnLoop(db, lease);
      const tick = firstTick + index * TICKS_PER_MONTH;
      await loop.advanceTo(tick - 1);
      const a = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: generalId } } });
      expect(await loop.advanceTo(tick)).toEqual([{ generalId, tick, commandKey: command.commandKey }]);
      const b = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: generalId } } });
      // 탈취 성공의 몫은 별도 효과다. 다른 세 계략은 확정 비용만 차감한다.
      if (command.commandKey !== 'plunder') {
        expect(a.gold - b.gold).toBe(100);
        expect(a.rice - b.rice).toBe(100);
      }
      expect(b.turnRevision).toBe(a.turnRevision + 1);
    }
    await new TurnLoop(db, lease).advanceTo(5 * TICKS_PER_MONTH);
  } finally {
    await releaseLease(db, lease);
  }
  const reopened = createDb(url!);
  try {
    const archive = await exportReplay(reopened, worldId);
    const firstReplay = replayArchive(archive, 5);
    expect(replayArchive(archive, 5)).toEqual(firstReplay);
    expect(firstReplay.at(-1)!.stateHash).toBe(
      hashState(await reopened.$transaction((tx) => loadReplayState(tx, worldId))),
    );
  } finally {
    await reopened.$disconnect();
  }
  expect(await readWorldState(db, otherWorld)).toEqual(initial);
});
