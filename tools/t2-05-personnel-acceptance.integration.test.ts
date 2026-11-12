import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { loadReplayState } from '../apps/engine/src/monthly';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { newSession } from '../apps/server/src/auth/session';
import { buildServer } from '../apps/server/src/server';
import { createDb } from '../packages/db/src/index';
import { monthlyDate, runMonthly, TICKS_PER_MONTH } from '../packages/rules/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { rngFor } from '../packages/shared/src/index';
import { testDatabaseUrl } from './test-database';

const url = testDatabaseUrl(process.env);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.searchParams.has('host') || url.searchParams.has('port'))
  throw new Error('loopback 시험 서버가 필요합니다.');
const db = createDb(url.href);
const origin = 'http://127.0.0.1:5173';
const app = await buildServer({ db, publicOrigin: origin, logging: false, emailVerificationRequired: true });
const worlds: string[] = [];
const users: string[] = [];
const quarter = 7 * TICKS_PER_MONTH;
let base: string;

beforeAll(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  try {
    await app.close();
    await db.world.deleteMany({ where: { id: { in: worlds } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  } finally {
    await db.$disconnect();
  }
});

async function advance(worldId: string, tick: number) {
  const lease = await acquireLease(db, worldId, randomUUID(), 60_000);
  if (!lease) throw new Error('인사 시험 월드의 실행권이 없습니다.');
  try {
    await new TurnLoop(db, lease).advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}

async function fixture() {
  const initial = commandInitial();
  initial.cities[0]!.connections = [4];
  initial.cities[1]!.connections = [3];
  initial.cities[3]!.connections = [1, 3];
  Object.assign(initial.generals[2]!, { nationId: 1, cityKey: 1, dedication: 100 });
  for (const general of initial.generals) general.nextTurnTick = 1_000_000;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '발령 응답과 NPC 인사 검증',
    turnTermMinutes: 60,
    endYear: null,
    ruleFeatures: ['personnel', 'policy'],
  });
  worlds.push(worldId);
  const userId = randomUUID();
  const now = Date.now();
  const session = newSession(now);
  await db.user.create({
    data: {
      id: userId,
      email: `${userId}@example.test`,
      emailVerifiedAt: new Date(now),
      passwordHash: 'not-a-login-hash',
      sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
    },
  });
  users.push(userId);
  await db.general.update({
    where: { worldId_id: { worldId, id: 3 } },
    data: { userId, residenceTick: 0, lastActiveTick: 0 },
  });
  await controlClock(db, worldId, 'start');
  const general = () => db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } });
  const turns = () => db.generalTurn.findMany({ where: { worldId, generalId: 3 }, orderBy: { slot: 'asc' } });
  const offers = () => db.assignmentOffer.findMany({ where: { worldId, targetGeneralId: 3 } });
  const history = (tick: number) =>
    db.nationHistory.findUniqueOrThrow({ where: { worldId_tick_nationId: { worldId, tick, nationId: 1 } } });
  return { worldId, seed: initial.seed, cookie: `sid=${session.token}`, general, turns, offers, history };
}

it.each([true, false])(
  'AC-M2-16 실제 HTTP 발령 응답(수락=%s)은 개인 턴을 쓰지 않는다',
  async (accept) => {
    const f = await fixture();
    await advance(f.worldId, quarter);
    const [offer] = await f.offers();
    expect(offer).toMatchObject({ status: 'PENDING', cityKey: 4, issuerGeneralId: 1 });
    const before = await f.general();
    const turns = await f.turns();
    expect(turns).toHaveLength(30);
    const requestId = randomUUID();
    const input = { worldId: f.worldId, requestId, offerId: offer!.id, accept };
    const respond = () =>
      fetch(`${base}/trpc/offers.respond`, {
        method: 'POST',
        headers: { origin, cookie: f.cookie, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    const first = respond();
    const where = { worldId: f.worldId, kind: 'offer.respond', idempotencyKey: `personnel:${requestId}` };
    try {
      await expect.poll(() => db.inputEvent.count({ where: { ...where, status: 'PENDING' } })).toBe(1);
      await advance(f.worldId, quarter);
      expect((await first).status).toBe(200);
      const result = await respond();
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ result: { data: { status: 'applied' } } });
    } finally {
      await first;
    }
    const status = accept ? 'ACCEPTED' : 'REJECTED';
    expect(await f.offers()).toMatchObject([{ status, resolvedBy: 'RESPONSE', resolvedTick: quarter }]);
    expect(await f.general()).toMatchObject({
      cityKey: accept ? 4 : 1,
      dedication: accept ? 100 : 90,
      nextTurnTick: before.nextTurnTick,
      turnRevision: before.turnRevision,
    });
    expect(await f.turns()).toEqual(turns);
    expect(await db.inputEvent.count({ where: { ...where, status: 'APPLIED' } })).toBe(1);
    expect(
      await db.generalLog.count({ where: { worldId: f.worldId, generalId: 3, commandKey: 'offer.respond' } }),
    ).toBe(1);
  },
  60_000,
);

it('AC-M2-16 NPC 군주는 정기 발령·포상과 사유를 기록하고 만료 발령은 한 번만 수락된다', async () => {
  const f = await fixture();
  const previousMonth = quarter - TICKS_PER_MONTH;
  await advance(f.worldId, previousMonth);
  expect(await f.offers()).toEqual([]);
  expect((await f.history(previousMonth)).data).not.toHaveProperty('events');
  const before = await db.$transaction((tx) => loadReplayState(tx, f.worldId));
  const date = monthlyDate(before.state.startYear, quarter);
  const baseline = runMonthly(before.state, quarter, rngFor(f.seed, 'monthly', date.year, date.month)).state;

  await advance(f.worldId, quarter);
  const expiresTick = quarter + 2 * TICKS_PER_MONTH;
  const [offer] = await f.offers();
  expect(offer).toMatchObject({ status: 'PENDING', createdTick: quarter, expiresTick, cityKey: 4, issuerGeneralId: 1 });
  expect(await f.general()).toMatchObject({ cityKey: 1, gold: baseline.generals[3]!.gold + 1_000 });
  expect(await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).toMatchObject({
    gold: baseline.nations[1]!.gold - 1_000,
  });
  const history = await f.history(quarter);
  expect(history.data).toMatchObject({
    events: [
      '장수3의 도시4 발령을 제안했습니다. 같은 도시에 6개월 넘게 머물렀고 현재 후방에 있습니다.',
      '장수3에게 공헌 순위에 따라 금 1000을 포상했습니다.',
    ],
  });
  await advance(f.worldId, quarter);
  expect((await f.history(quarter)).data).toEqual(history.data);
  await advance(f.worldId, expiresTick - 1);
  expect(await f.offers()).toMatchObject([{ id: offer!.id, status: 'PENDING' }]);
  const turns = await f.turns();
  await advance(f.worldId, expiresTick);
  await advance(f.worldId, expiresTick);
  expect(await f.offers()).toMatchObject([
    { id: offer!.id, status: 'ACCEPTED', resolvedBy: 'EXPIRY', resolvedTick: expiresTick },
  ]);
  expect(await f.general()).toMatchObject({ cityKey: 4, residenceTick: expiresTick, nextTurnTick: 1_000_000 });
  expect(await f.turns()).toEqual(turns);
  expect(
    await db.generalLog.findMany({ where: { worldId: f.worldId, generalId: 3, commandKey: 'offer.expire' } }),
  ).toMatchObject([{ tick: expiresTick, text: '도시4 발령 기한이 지나 수락했습니다.' }]);
  expect(await db.inputEvent.count({ where: { worldId: f.worldId, kind: 'offer.respond' } })).toBe(0);
}, 60_000);
