import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildInitialWorld, type WorldInit } from '../packages/rules/src/index';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease, renewLease, LEASE_TTL_MS } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive, replayToEnd } from '../apps/engine/src/replay';
import { setTimeout as delay } from 'node:timers/promises';

// AC-INT-09의 CITY/PASS 저장·멸망 분기만 검사하는 3인 통제 고정물이다.
// 정식 21국·491명 사람 플레이와 AC-INT-12 전체 기수 증거를 대신하지 않는다.
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)
)
  throw new Error('loopback 전용 검사 DB가 필요합니다.');
const db = createDb(url);
const origin = 'http://127.0.0.1:5173';
const app = await buildServer({ db, logging: false, publicOrigin: origin });
const users: string[] = [],
  cookies: string[] = [];
let base: string, worldId: string, initial: WorldInit, attackerUnit: number, defenderUnit: number, reserveUnit: number;
let passTick: number, cityTick: number;
let preparation: Promise<void> | undefined, execution: Promise<unknown> | undefined;
const it = (name: string, action: () => Promise<void>) => test(name, () => (execution = action()));
beforeEach(async () => {
  await execution?.catch(() => undefined);
});
async function http<T = unknown>(path: string, input: unknown, index = 0, mutation = false): Promise<T> {
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${base}/trpc/${path}?batch=1${mutation ? '' : '&input=' + encodeURIComponent(encoded)}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, cookie: cookies[index]!, ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const [body] = (await response.json()) as Array<{ result?: { data: T }; error?: { message: string } }>;
  if (!body?.result) throw new Error(`${path}: ${body?.error?.message ?? 'HTTP 결과가 없습니다.'}`);
  return body.result.data;
}
async function snapshot() {
  return db.$transaction((tx) => loadReplayState(tx, worldId), { isolationLevel: 'RepeatableRead' });
}
async function advance(tick: number) {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('검사 실행권이 없습니다.');
  const controller = new AbortController();
  let renewalError: unknown;
  const renewal = (async () => {
    while (!controller.signal.aborted) {
      try {
        await delay(LEASE_TTL_MS / 3, undefined, { signal: controller.signal });
        if (!controller.signal.aborted) await renewLease(db, lease);
      } catch (error) {
        if (!controller.signal.aborted) {
          renewalError = error;
          controller.abort();
        }
      }
    }
  })();
  try {
    await new TurnLoop(db, lease).advanceTo(tick, controller.signal);
    if (renewalError) throw renewalError;
  } finally {
    controller.abort();
    await renewal;
    await releaseLease(db, lease);
  }
}
async function input(path: string, payload: object, index: number) {
  const board = await http<{ revision: number }>('campaign.get', { worldId }, index);
  const requestId = randomUUID();
  await http(path, { worldId, requestId, payload: { ...payload, revision: board.revision } }, index, true);
  await advance((await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick);
  const receipt = await http<{ status: string; result: { unitId: number; offerId: number } }>(
    'campaign.request',
    { worldId, requestId },
    index,
  );
  expect(receipt.status).toBe('applied');
  return receipt.result;
}
beforeAll(
  () =>
    (preparation = (async () => {
      const passwordHash = await hashPassword(randomUUID());
      for (let index = 0; index < 3; index++) {
        const user = await db.user.create({ data: { email: `int09-${randomUUID()}@example.invalid`, passwordHash } });
        users.push(user.id);
        const session = newSession(Date.now());
        await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
        cookies.push(`sid=${session.token}`);
      }
      const source = operationalInput();
      source.scenario.nation[0]![8] = ['도시1'];
      source.scenario.nation[1]![8] = ['도시2', '관문'];
      source.scenario.general = [];
      source.scenario.generalStats = [];
      for (const site of source.map.sites) {
        if (site.kind === 'CITY') {
          site.initial.wall = 0;
          site.initial.defence = 0;
          site.initial.commerce = site.max.commerce = 100000;
          site.initial.agriculture = site.max.agriculture = 100000;
        }
        if (site.kind === 'PASS') {
          site.wall.initial = 0;
          site.defence.initial = 0;
        }
      }
      initial = buildInitialWorld(source);
      initial.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'];
      for (const nation of initial.nations) nation.isNpc = false;
      initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
      ({ worldId } = await saveInitialWorld(db, initial, {
        name: 'INT09 통제 점령 저장',
        turnTermMinutes: 60,
        endYear: 201,
      }));
      await controlClock(db, worldId, 'start');
      base = await app.listen({ host: '127.0.0.1', port: 0 });
    })()),
);
afterAll(async () => {
  await preparation?.catch(() => undefined);
  await execution?.catch(() => undefined);
  try {
    await app.close();
    if (worldId) await db.world.delete({ where: { id: worldId } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  } finally {
    await db.$disconnect();
  }
});

it('실제 HTTP 편성·동의·30칸 예약으로 두 나라의 부대를 준비한다', async () => {
  for (let index = 0; index < 3; index++) {
    let failure: unknown;
    const creating = http(
      'general.create',
      {
        worldId,
        name: `통제장수${index}`,
        portraitId: null,
        leadership: 55,
        strength: 55,
        intel: 55,
        politics: 55,
        charm: 55,
      },
      index,
      true,
    ).catch((error) => {
      failure = error;
    });
    try {
      await expect
        .poll(() =>
          db.inputEvent.count({ where: { worldId, userId: users[index]!, kind: 'general.create', status: 'PENDING' } }),
        )
        .toBe(1);
      await advance(0);
    } finally {
      await creating;
    }
    if (failure) throw failure;
    const general = await db.general.findUniqueOrThrow({
      where: { worldId_userId: { worldId, userId: users[index]! } },
    });
    expect(general.id).toBe(index + 1);
    const turns = await http<{ revision: number }>('turns.get', { worldId }, index);
    await http(
      'turns.set',
      {
        worldId,
        revision: turns.revision,
        slots: [
          { commandKey: 'join', args: { nationId: index === 0 ? 1 : 2 } },
          ...Array.from({ length: 29 }, () => ({ commandKey: 'rest', args: {} })),
        ],
      },
      index,
      true,
    );
  }
  const joining = await db.general.findMany({ where: { worldId } });
  await advance(Math.max(...joining.map((general) => general.nextTurnTick)));
  // 임의 UUID의 정상 턴 offset을 보존하고 첫 7월 급료로 준비 비용을 마련한다.
  await advance(60000);
  const actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
  expect(actor.nationId).toBe(1);
  passTick = actor.nextTurnTick + 21 * 10000;
  cityTick = passTick + 10000;
  attackerUnit = (await input('campaign.unit', { type: 'form', commanderId: 1, crewType: 1100 }, 0)).unitId;
  defenderUnit = (await input('campaign.unit', { type: 'form', commanderId: 2, crewType: 1100 }, 1)).unitId;
  reserveUnit = (await input('campaign.unit', { type: 'form', commanderId: 3, crewType: 1100 }, 2)).unitId;
  const offer = await input('campaign.relationship', { type: 'offer', targetId: 3, relation: 'STAFF' }, 1);
  await input('campaign.relationship', { type: 'respond', offerId: offer.offerId, accept: true }, 2);
  for (let index = 0; index < 3; index++) {
    const unitId = index === 0 ? attackerUnit : defenderUnit;
    const planned =
      index === 2
        ? [
            { commandKey: 'recruit', args: { unitId: reserveUnit, amount: 7, crewType: 1100 } },
            { commandKey: 'move', args: { cityKey: 99 } },
          ]
        : [
            { commandKey: 'recruit', args: { unitId, amount: index === 0 ? 500 : 10, crewType: 1100 } },
            ...Array.from({ length: 10 }, () => ({ commandKey: 'train', args: { unitId } })),
            ...Array.from({ length: 10 }, () => ({ commandKey: 'morale', args: { unitId } })),
            ...(index === 0
              ? [
                  { commandKey: 'attack', args: { cityKey: 99 } },
                  { commandKey: 'attack', args: { cityKey: 2 } },
                ]
              : []),
          ];
    const turns = await http<{ revision: number }>('turns.get', { worldId }, index);
    await http(
      'turns.set',
      {
        worldId,
        revision: turns.revision,
        slots: [...planned, ...Array.from({ length: 30 - planned.length }, () => ({ commandKey: 'rest', args: {} }))],
      },
      index,
      true,
    );
  }
  await advance(passTick - 1);
  const state = await snapshot();
  expect(state.state.campaign!.units.find((unit) => unit.id === attackerUnit)).toMatchObject({
    troops: 500,
    train: 100,
    atmos: 100,
  });
  expect(state.state.campaign!.units.find((unit) => unit.id === defenderUnit)).toMatchObject({
    troops: 10,
    train: 100,
    atmos: 100,
  });
  expect(state.state.campaign!.units.find((unit) => unit.id === reserveUnit)).toMatchObject({
    ownerId: 3,
    commanderId: 3,
    troops: 7,
    train: 0,
    atmos: 0,
  });
  expect(state.state.generals[3]!.cityKey).toBe(99);
  expect(state.state.campaign!.links).toEqual([{ masterId: 2, personId: 3, relation: 'STAFF' }]);
  expect(await db.generalTurn.count({ where: { worldId } })).toBe(90);
});
it('PASS 점령은 군량을 한 번 차감하고 경제 CITY가 남은 적국을 보존한다', async () => {
  const before = await snapshot();
  await advance(passTick);
  const after = await snapshot();
  expect(after.state.cities[99]).toMatchObject({ kind: 'PASS', nationId: 1 });
  expect(after.state.nations[2]).toMatchObject({ capitalCityKey: 2 });
  expect(after.state.generals[1]!.rice).toBe(before.state.generals[1]!.rice - 5);
  expect(after.state.generals[1]!.crew).toBe(0);
  expect((await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 99 } } })).nationId).toBe(1);
  expect(
    (await db.generalLog.findFirstOrThrow({ where: { worldId, generalId: 1, tick: passTick, commandKey: 'attack' } }))
      .text,
  ).toContain('점령');
  const stable = hashState(after);
  await advance(passTick);
  expect(hashState(await snapshot())).toBe(stable);
});
it('마지막 CITY 상실의 멸망·소속 해제·개인 관계/부곡/타인 예약과 모든 월·종료 재생을 보존한다', async () => {
  await advance(cityTick - 1);
  const before = await snapshot();
  const otherTurns = await db.generalTurn.findMany({ where: { worldId, generalId: 3 }, orderBy: { slot: 'asc' } });
  await advance(cityTick);
  const after = await snapshot();
  expect(after.state.cities[2]).toMatchObject({ kind: 'CITY', nationId: 1 });
  expect(after.state.nations[2]).toBeUndefined();
  expect(await db.nation.count({ where: { worldId, id: 2 } })).toBe(0);
  for (const id of [2, 3]) expect(after.state.generals[id]).toMatchObject({ nationId: null, officerLevel: 0, crew: 0 });
  expect(after.state.campaign!.links).toEqual(before.state.campaign!.links);
  expect(after.state.campaign!.units.map((unit) => unit.id)).toEqual(
    before.state.campaign!.units.map((unit) => unit.id),
  );
  expect(after.state.campaign!.units.find((unit) => unit.id === defenderUnit)).toMatchObject({
    ownerId: 2,
    commanderId: 2,
    troops: 0,
  });
  expect(after.state.campaign!.units.find((unit) => unit.id === reserveUnit)).toEqual(
    before.state.campaign!.units.find((unit) => unit.id === reserveUnit),
  );
  expect(after.state.campaign!.units.find((unit) => unit.id === reserveUnit)!.troops).toBe(7);
  expect(after.state.campaign!.units.find((unit) => unit.id === attackerUnit)!.troops).toBeGreaterThan(400);
  expect(after.state.generals[1]!.rice).toBe(before.state.generals[1]!.rice - 10);
  expect(after.state.generals[2]!.rice).toBe(before.state.generals[2]!.rice - 1);
  expect(after.state.generals[3]!.rice).toBe(before.state.generals[3]!.rice);
  const storedCampaign = (await db.world.findUniqueOrThrow({ where: { id: worldId } })).campaignState;
  expect(storedCampaign).toEqual(after.state.campaign);
  expect(await db.generalTurn.findMany({ where: { worldId, generalId: 3 }, orderBy: { slot: 'asc' } })).toEqual(
    otherTurns,
  );
  expect(await db.battleLog.count({ where: { worldId, tick: cityTick, attackerId: 1, generalId: 2 } })).toBe(1);
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).toMatchObject({
    captures: 2,
    battleWins: 1,
  });
  const history = await db.nationHistory.findUniqueOrThrow({
    where: { worldId_tick_nationId: { worldId, tick: cityTick, nationId: 2 } },
  });
  expect(JSON.stringify(history.data)).toContain('멸망');
  const archive = await exportReplay(db, worldId);
  const first = replayArchive(archive, archive.months.length);
  expect(first).toHaveLength(Math.floor(cityTick / 10000));
  expect(replayArchive(archive, archive.months.length)).toEqual(first);
  const end = replayToEnd(archive);
  expect(replayToEnd(archive)).toEqual(end);
  const result = await db.worldResult.findUniqueOrThrow({ where: { worldId } });
  expect(result.reason).toBe('UNIFIED');
  expect(result.finalStateHash).toBe(end.finalStateHash);
  expect(result.finalStateHash).toBe(hashState(after));
});
