import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { inferRouterOutputs } from '@trpc/server';
import { createDb } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveFixtureWorld as saveInitialWorld } from '../e2e/worldFixture';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { settlePendingBattle } from '../apps/engine/test/tacticalSettlement';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState, persistMonthly } from '../apps/engine/src/monthly';
import { appendReputationEvents, loadReputationLedger } from '../apps/engine/src/reputationState';
import { exportReplay, replayArchive, replayToEnd } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import type { AppRouter } from '../apps/server/src/router';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { recruitmentFixtureData } from './fixtures/recruitment';
import { recordTestTurns } from '../apps/engine/test/seasonFixture';
import type { WorldInit } from '../packages/rules/src/index';
import { testDatabaseUrl } from './test-database';

const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.searchParams.has('host') || url.searchParams.has('port'))
  throw Error('월단평 시험은 loopback 전용 DB가 필요합니다.');
const db = createDb(url.href),
  worldIds: string[] = [],
  userIds: string[] = [];
const now = Date.now(),
  app = await buildServer({ db, now: () => now, logging: false });
let base: string;
type Output = inferRouterOutputs<AppRouter>;
type Results = {
  'review.latest': Output['review']['latest'];
  'review.get': Output['review']['get'];
  'review.months': Output['review']['months'];
  'records.world': Output['records']['world'];
  'turns.set': Output['turns']['set'];
};
type Player = { id: string; cookie: string };
async function rpc<R extends keyof Results>(route: R, input: unknown, player?: Player) {
  const mutation = route === 'turns.set',
    encoded = JSON.stringify(input);
  const response = await fetch(`${base}/trpc/${route}${mutation ? '' : `?input=${encodeURIComponent(encoded)}`}`, {
    method: mutation ? 'POST' : 'GET',
    headers: {
      origin: 'http://127.0.0.1:5173',
      ...(player ? { cookie: player.cookie } : {}),
      ...(mutation ? { 'content-type': 'application/json' } : {}),
    },
    ...(mutation ? { body: encoded } : {}),
  });
  const text = await response.text();
  const body = JSON.parse(text) as {
    result?: { data: Results[R] };
    error?: { message: string; data: { code: string } };
  };
  return { status: response.status, data: body.result?.data, error: body.error, text };
}
async function user(sanctioned = false): Promise<Player> {
  const id = randomUUID();
  await db.user.create({
    data: {
      id,
      email: `${id}@example.invalid`,
      passwordHash: 'test-only',
      emailVerifiedAt: new Date(now),
      status: sanctioned ? 'SANCTIONED' : 'ACTIVE',
    },
  });
  userIds.push(id);
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
  return { id, cookie: `sid=${session.token}` };
}
const preparedWorlds = new Set<string>();
const preparationOwners = new Map<string, string[]>();
async function prepareReviewWorld(initial: WorldInit, armies: Array<{ generalId: number; troops: number }>) {
  const started = performance.now();
  const key = initial.generals.map((general) => general.userId ?? '').join(',');
  let owners = preparationOwners.get(key);
  if (!owners) {
    owners = [];
    for (const general of initial.generals) owners.push(general.userId ?? (await user()).id);
    preparationOwners.set(key, owners);
  }
  initial.nations = initial.nations.map((nation) => ({ ...nation, isNpc: false }));
  for (const [index, general] of initial.generals.entries()) {
    general.userId = owners[index]!;
    general.crew = 0;
    general.gold = general.rice = 10_000_000;
    if (armies.some((army) => army.generalId === general.id)) general.nextTurnTick = general.id * 100;
  }
  for (const city of initial.cities) {
    city.population = city.populationMax = 50000;
    city.commerce = city.commerceMax = 2_000_000;
    const farmingRoom = city.agricultureMax - city.agriculture;
    city.agriculture = 2_000_000;
    city.agricultureMax = 2_000_000 + farmingRoom;
  }
  syncFixtureMap(initial);
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '월단평 실제 부곡 준비',
    turnTermMinutes: 60,
    endYear: null,
    featureData: recruitmentFixtureData(initial),
  });
  worldIds.push(worldId);
  await controlClock(db, worldId, 'start');
  await advance(worldId, 10000);
  for (let step = 0; step < 9; step++) {
    let last = 0;
    for (const army of armies) {
      const general = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: army.generalId } } });
      const commandKey = step === 0 ? 'recruit' : step <= 4 ? 'train' : 'morale';
      await recordTestTurns(
        db,
        worldId,
        army.generalId,
        commandKey,
        step === 0 ? { amount: army.troops, crewType: 1100, unitId: 'new' } : {},
      );
      last = Math.max(last, general.nextTurnTick);
    }
    await advance(worldId, last);
  }
  await advance(worldId, 100000);
  const state = (await snapshot(worldId)).state;
  for (const army of armies)
    expect(state.campaign!.units).toContainEqual(
      expect.objectContaining({
        ownerId: army.generalId,
        troops: army.troops,
        train: expect.any(Number),
        atmos: expect.any(Number),
      }),
    );
  console.info(
    JSON.stringify({ event: 'monthly-review-preparation', ms: performance.now() - started, armies: armies.length }),
  );
  preparedWorlds.add(worldId);
  return { worldId };
}
async function advance(worldId: string, tick: number, fail = false) {
  if (preparedWorlds.has(worldId)) tick += 100000;
  const lease = await acquireLease(db, worldId, randomUUID(), 120_000);
  if (!lease) throw Error('월단평 시험의 실행권이 없습니다.');
  try {
    const loop = new TurnLoop(
      db,
      lease,
      fail
        ? {
            beforeCommit: async () => {
              throw Error('review-rollback');
            },
          }
        : {},
    );
    if (preparedWorlds.has(worldId) && !fail) {
      while ((await db.world.findUniqueOrThrow({ where: { id: worldId } })).status === 'RUNNING') {
        const next = await db.general.findFirst({
          where: { worldId, removedAt: null },
          orderBy: { nextTurnTick: 'asc' },
          select: { nextTurnTick: true },
        });
        if (!next || next.nextTurnTick > tick) break;
        await loop.advanceTo(next.nextTurnTick);
        await settlePendingBattle(db, worldId);
      }
    }
    await loop.advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}
const snapshot = (worldId: string) => db.$transaction((tx) => loadReplayState(tx, worldId));
async function fixture(players?: [Player, Player]) {
  const initial = await monthlyFixture();
  // 실제 준비 뒤 11월에도 기존 점령·내정 문구를 고정한다.
  initial.seed = 'monthly-review-integration-11';
  initial.generals = initial.generals.map((general) => ({ ...general, nextTurnTick: 1_000_000_000, injury: 0 }));
  if (players) {
    Object.assign(initial.generals[0]!, {
      userId: players[0].id,
      cityKey: 1,
      nextTurnTick: 100,
      crew: 0,
      rice: 100000,
      train: 100,
      atmos: 100,
    });
    Object.assign(initial.generals[1]!, { cityKey: 2, crew: 0, train: 100, atmos: 100 });
    Object.assign(initial.generals[2]!, {
      userId: players[1].id,
      cityKey: 1,
      activeFromYear: initial.startYear,
      nextTurnTick: 500,
      gold: 100000,
    });
    initial.cities.find((row) => row.cityKey === 2)!.wall = 0;
    const city = initial.cities.find((row) => row.cityKey === 1)!;
    city.agriculture = city.agricultureMax - 1;
    initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
  }

  syncFixtureMap(initial);

  const { worldId } = players
    ? await prepareReviewWorld(initial, [
        { generalId: 1, troops: 1900 },
        { generalId: 2, troops: 20 },
      ])
    : await saveInitialWorld(db, initial, {
        name: '월단평 실제 검증',
        turnTermMinutes: 60,
        endYear: null,
        replayFormat: 3,
      });
  if (!players) {
    worldIds.push(worldId);
    await controlClock(db, worldId, 'start');
  }
  if (players)
    for (const [index, player] of players.entries()) {
      const result = await rpc(
        'turns.set',
        {
          worldId,
          revision: (await db.general.findFirstOrThrow({ where: { worldId, userId: player.id } })).turnRevision,
          slots: Array.from({ length: 30 }, (_, slot) =>
            slot === 0
              ? { commandKey: index === 0 ? 'attack' : 'farm', args: index === 0 ? { cityKey: 2 } : {} }
              : { commandKey: 'rest', args: {} },
          ),
        },
        player,
      );
      expect(result.status, result.text).toBe(200);
      expect(result.data?.ok).toBe(true);
    }
  return { worldId, initial };
}
beforeAll(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worldIds } } });
  // 종료 때 적립된 불변 유산 원장과 그 계정은 전용 DB 정리까지 보존한다.
  await db.user.deleteMany({ where: { id: { in: userIds }, heritageAccount: { is: null } } });
  await db.$disconnect();
});

it('T3-07 AC-M3-15 실제 전투·내정 사건과 월 정산은 기존 기록을 보존하고 12개월 재생된다', async () => {
  const players: [Player, Player] = [await user(), await user()];
  const modern = await fixture(players),
    replica = await fixture(players);
  for (const { worldId } of [modern, replica]) await advance(worldId, 10000);
  const events = await db.reputationEvent.findMany({ where: { worldId: modern.worldId }, orderBy: { id: 'asc' } });
  expect(
    events.map((row) => [row.generalId, row.kind]),
    JSON.stringify(
      await db.generalLog.findMany({
        where: { worldId: modern.worldId, tick: { gt: 100000 } },
        select: { tick: true, generalId: true, commandKey: true, kind: true, text: true },
      }),
    ),
  ).toEqual([
    [1, 'victory'],
    [2, 'defeat'],
    [1, 'conquest'],
    [3, 'domestic'],
  ]);
  expect(events.find((row) => row.kind === 'domestic')).toMatchObject({ cityKey: null, cityName: null });
  const stored = await snapshot(modern.worldId),
    replicated = await snapshot(replica.worldId);
  expect(replicated.reputation).toEqual(stored.reputation);
  // 독립 실행의 DB 시각은 다르다. 각 원본 시각을 포함한 해시는 아래에서 각자 재생한다.
  const withoutDeadlines = (replay: typeof stored) => {
    const copy = structuredClone(replay);
    for (const battle of copy.state.campaign?.tactical?.battles ?? []) {
      battle.deadlineAt = 0;
      battle.hardDeadlineAt = 0;
    }
    return copy;
  };
  expect(withoutDeadlines(stored)).toEqual(withoutDeadlines(replicated));
  for (const { worldId } of [modern, replica]) expect((await exportReplay(db, worldId)).months).toHaveLength(11);
  const replicaRows = await db.yearbookSnapshot.findMany({
    where: { worldId: replica.worldId },
    select: { tick: true, year: true, month: true, sequence: true, data: true },
  });
  expect(
    await db.yearbookSnapshot.findMany({
      where: { worldId: modern.worldId },
      select: { tick: true, year: true, month: true, sequence: true, data: true },
    }),
  ).toEqual(replicaRows);
  const logs = (worldId: string) =>
    db.generalLog.findMany({
      where: { worldId },
      orderBy: [{ sequence: 'asc' }, { ordinal: 'asc' }],
      select: { tick: true, generalId: true, sequence: true, ordinal: true, text: true, commandKey: true, kind: true },
    });
  expect(await logs(modern.worldId)).toEqual(await logs(replica.worldId));
  const histories = (worldId: string) =>
    db.nationHistory.findMany({
      where: { worldId },
      orderBy: [{ tick: 'asc' }, { nationId: 'asc' }],
      select: { tick: true, nationId: true, data: true },
    });
  expect(await histories(modern.worldId)).toEqual(await histories(replica.worldId));
  const ranking = (worldId: string) =>
    db.rankingSnapshot.findUnique({ where: { worldId }, select: { tick: true, generals: true, nations: true } });
  expect(await ranking(modern.worldId)).toEqual(await ranking(replica.worldId));
  expect(await db.reputationEvent.count({ where: { worldId: replica.worldId } })).toBe(events.length);
  expect(await db.monthlyReview.count({ where: { worldId: replica.worldId } })).toBe(11);
  expect(stored.reputation?.reviews.at(-1)?.entries.map((row) => [row.generalId, row.score])).toEqual([
    [1, 8],
    [3, 2],
  ]);
  expect(stored.reputation!.reviews.at(-1)!).toMatchObject({
    year: 191,
    month: 11,
    tick: 110000,
    headline: '191년 11월 월단평 1위 소제1, 2위 사마휘',
    entries: [
      { rank: 1, generalId: 1, score: 8, kinds: ['conquest', 'victory'], line: '소제1가 도시2 점령을 이끌었다.' },
      { rank: 2, generalId: 3, score: 2, kinds: ['domestic'], line: '사마휘의 내정 성과가 기록에 올랐다.' },
    ],
  });
  const first = await db.yearbookSnapshot.findFirstOrThrow({ where: { worldId: modern.worldId, tick: 110000 } });
  expect(hashState(stored)).toBe(first.stateHash);
  const strip = { ...stored };
  delete strip.reputation;
  expect(hashState(strip)).not.toBe(first.stateHash);
  const publicReview = await rpc('review.latest', { worldId: modern.worldId }, players[0]);
  expect(publicReview.data?.entries).toEqual(stored.reputation!.reviews.at(-1)!.entries);
  expect(Object.keys(publicReview.data!).sort()).toEqual(['entries', 'month', 'year']);
  const publicRecords = await rpc('records.world', { worldId: modern.worldId }, players[0]);
  expect(publicRecords.data?.items[0]?.review?.headline).toBe(stored.reputation!.reviews.at(-1)!.headline);
  expect((await rpc('records.world', { worldId: replica.worldId }, players[0])).data?.items[0]?.review?.headline).toBe(
    stored.reputation!.reviews.at(-1)!.headline,
  );
  for (const key of ['gold', 'rice', 'crew', 'stateHash', 'seed', 'agriculture'])
    expect(publicReview.text).not.toContain(`"${key}"`);
  for (const { worldId } of [modern, replica]) {
    await advance(worldId, 120000);
    const archive = await exportReplay(db, worldId);
    expect(replayArchive(archive, 22)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  }
}, 60_000);

it('T3-07 AC-M3-15 사건은 최초 값을 보존하고 실패한 턴·정산은 원자적으로 되돌린다', async () => {
  const players: [Player, Player] = [await user(), await user()],
    f = await fixture(players);
  const before = await snapshot(f.worldId);
  await expect(advance(f.worldId, 100, true)).rejects.toThrow('review-rollback');
  expect(await snapshot(f.worldId)).toEqual(before);
  expect(await db.reputationEvent.count({ where: { worldId: f.worldId } })).toBe(0);
  await advance(f.worldId, 100);
  const current = await snapshot(f.worldId),
    first = current.reputation!.events[0]!;
  expect(
    first,
    JSON.stringify(
      await db.generalLog.findMany({ where: { worldId: f.worldId, tick: { gt: 100000 } }, select: { text: true } }),
    ),
  ).toBeDefined();
  await db.$transaction((tx) =>
    appendReputationEvents(tx, f.worldId, [
      { ...first, tick: 1, data: { ...first.data, name: '후속 덮어쓰기 금지' } },
      first,
    ]),
  );
  expect(await snapshot(f.worldId)).toEqual(current);
  await advance(f.worldId, 9999);
  const monthBefore = await snapshot(f.worldId);
  await expect(advance(f.worldId, 10000, true)).rejects.toThrow('review-rollback');
  expect(await snapshot(f.worldId)).toEqual(monthBefore);
  expect(await db.monthlyReview.count({ where: { worldId: f.worldId } })).toBe(10);
  await advance(f.worldId, 10000);
  const settled = await snapshot(f.worldId),
    review = settled.reputation!.reviews.at(-1)!;
  const originalWorld = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
  await expect(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id=${f.worldId} FOR UPDATE`;
      await tx.world.update({ where: { id: f.worldId }, data: { clockRevision: { increment: 1 } } });
      await persistMonthly(tx, f.worldId, f.initial.seed, 110000, originalWorld.actionSequence + 1);
    }),
  ).rejects.toThrow('가문 월 정산이 중복되거나 달을 건너뛰었습니다.');
  expect(await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).toEqual(originalWorld);
  await expect(
    db.$transaction(async (tx) => {
      await tx.world.update({ where: { id: f.worldId }, data: { clockRevision: { increment: 1 } } });
      await tx.monthlyReview.create({ data: { worldId: f.worldId, ...review } });
    }),
  ).rejects.toMatchObject({ code: 'P2002' });
  expect(await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).toEqual(originalWorld);
  expect(await snapshot(f.worldId)).toEqual(settled);
  await expect(
    db.$transaction(async (tx) => {
      await tx.monthlyReview.update({
        where: { worldId_year_month: { worldId: f.worldId, year: review.year, month: review.month } },
        data: {
          entries: review.entries.map((entry, index) =>
            index === 0 ? { ...entry, line: entry.line + ' 변경' } : entry,
          ),
        },
      });
      expect(hashState(await loadReplayState(tx, f.worldId))).not.toBe(hashState(settled));
      throw Error('rollback-review-hash-probe');
    }),
  ).rejects.toThrow('rollback-review-hash-probe');
  expect(await snapshot(f.worldId)).toEqual(settled);
  await expect(
    db.$transaction(async (tx) => {
      await tx.reputationEvent.deleteMany({ where: { worldId: f.worldId, kind: 'victory' } });
      expect(hashState(await loadReplayState(tx, f.worldId))).not.toBe(hashState(settled));
      throw Error('rollback-hash-probe');
    }),
  ).rejects.toThrow('rollback-hash-probe');
  expect(await snapshot(f.worldId)).toEqual(settled);
});

it('T3-07 AC-M3-15 실제 조약 파기의 적용·거절·롤백은 큐 입력 원장과 재생에 일치한다', async () => {
  const alice = await user(),
    bob = await user(),
    initial = await monthlyFixture();
  initial.nations = initial.nations.map((row) => ({ ...row, isNpc: false, gold: 1000 }));
  initial.generals = initial.generals.map((row) => ({
    ...row,
    nextTurnTick: 1_000_000_000,
    ...(row.id < 3 ? { userId: row.id === 1 ? alice.id : bob.id, officerLevel: 12 } : {}),
  }));
  syncFixtureMap(initial);
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '월단평 파기 입력 검증',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
  });
  worldIds.push(worldId);
  await controlClock(db, worldId, 'start');
  const propose = await db.inputEvent.create({
    data: {
      worldId,
      userId: alice.id,
      generalId: 1,
      kind: 'treaty.propose',
      idempotencyKey: `treaty.propose:${randomUUID()}`,
      payload: { toNationId: 2, clauses: [{ kind: 'peace' }, { kind: 'nonAggression', months: 12 }] },
    },
  });
  await advance(worldId, 1);
  const proposed = await db.inputEvent.findUniqueOrThrow({ where: { id: propose.id } });
  expect(proposed.status).toBe('APPLIED');
  const treatyId = (proposed.result as { treatyId: string }).treatyId;
  expect(treatyId).toMatch(/^[1-9][0-9]*$/);
  const respond = await db.inputEvent.create({
    data: {
      worldId,
      userId: bob.id,
      generalId: 2,
      kind: 'treaty.respond',
      idempotencyKey: `treaty.respond:${randomUUID()}`,
      payload: { treatyId, accept: true },
    },
  });
  await advance(worldId, 2);
  const responded = await db.inputEvent.findUniqueOrThrow({ where: { id: respond.id } });
  expect(responded.status, JSON.stringify(responded.result)).toBe('APPLIED');
  const enqueue = () =>
    db.inputEvent.create({
      data: {
        worldId,
        userId: alice.id,
        generalId: 1,
        kind: 'treaty.break',
        idempotencyKey: `treaty.break:${randomUUID()}`,
        payload: { treatyId },
      },
    });
  const breaking = await enqueue(),
    before = await snapshot(worldId);
  await expect(advance(worldId, 3, true)).rejects.toThrow('review-rollback');
  expect(await snapshot(worldId)).toEqual(before);
  expect((await db.inputEvent.findUniqueOrThrow({ where: { id: breaking.id } })).status).toBe('PENDING');
  expect(await db.reputationEvent.count({ where: { worldId } })).toBe(0);
  await advance(worldId, 3);
  expect((await db.inputEvent.findUniqueOrThrow({ where: { id: breaking.id } })).status).toBe('APPLIED');
  expect((await snapshot(worldId)).reputation?.events).toMatchObject([
    { generalId: 1, tick: 3, kind: 'betrayal', score: -3, data: { name: initial.generals[0]!.name, city: null } },
  ]);
  const repeated = await enqueue();
  await advance(worldId, 4);
  expect((await db.inputEvent.findUniqueOrThrow({ where: { id: repeated.id } })).status).toBe('REJECTED');
  expect(await db.reputationEvent.count({ where: { worldId } })).toBe(1);
  await advance(worldId, 10000);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('T3-07 AC-M3-15 빈 달도 보존하고 최근 24개월 조회와 세계 기록 커서를 유지한다', async () => {
  const f = await fixture(),
    reader = await user();
  await advance(f.worldId, 320000);
  const ledger = await db.$transaction((tx) => loadReputationLedger(tx, f.worldId, 191));
  expect(ledger.reviews).toHaveLength(32);
  expect(ledger.reviews.every((row) => row.entries.length === 0 && row.headline === null)).toBe(true);
  const months = await rpc('review.months', { worldId: f.worldId }, reader);
  expect(months.data).toEqual(
    ledger.reviews
      .slice(-24)
      .reverse()
      .map(({ year, month }) => ({ year, month })),
  );
  expect((await rpc('review.get', { worldId: f.worldId, year: 191, month: 1 }, reader)).data).toEqual({
    year: 191,
    month: 1,
    entries: [],
  });
  const first = await rpc('records.world', { worldId: f.worldId }, reader);
  expect(first.data?.items).toHaveLength(30);
  expect(first.data?.nextCursor).toBe('30000');
  const last = await rpc('records.world', { worldId: f.worldId, cursor: first.data!.nextCursor }, reader);
  expect(last.data?.items.map((row) => row.tick)).toEqual([20000, 10000]);
  expect(last.data?.nextCursor).toBeNull();
  expect(first.data?.items.every((row) => !('review' in row))).toBe(true);
}, 60_000);

for (const route of ['review.latest', 'review.get', 'review.months'] as const)
  for (const category of categories)
    it(
      `T3-07 AC-M3-15 ${route} ${category}`,
      authzCase(route, category, async () => {
        const f = await fixture(),
          reader = await user(),
          other = await user(),
          sanctioned = await user(true);
        await advance(f.worldId, 10000);
        const input = { worldId: f.worldId, ...(route === 'review.get' ? { year: 191, month: 1 } : {}) };
        const before = await snapshot(f.worldId);
        if (category === 'success' || category === 'otherUser') {
          const result = await rpc(route, input, category === 'success' ? reader : other);
          expect(result.status, result.text).toBe(200);
          expect(result.data).toEqual(
            route === 'review.months' ? [{ year: 191, month: 1 }] : { year: 191, month: 1, entries: [] },
          );
        } else if (category === 'invalidInput') {
          expect((await rpc(route, { ...input, actorId: 1 }, reader)).error?.data.code).toBe('BAD_REQUEST');
          expect((await rpc(route, { ...input, worldId: randomUUID() }, reader)).error?.data.code).toBe('NOT_FOUND');
          if (route === 'review.get') {
            for (const invalid of [{ year: -1 }, { year: 2147483648 }, { month: 13 }, { month: 1.5 }])
              expect((await rpc(route, { ...input, ...invalid }, reader)).error?.data.code).toBe('BAD_REQUEST');
            expect((await rpc(route, { ...input, year: 190 }, reader)).data).toBeNull();
          }
        } else
          expect((await rpc(route, input, category === 'sanctioned' ? sanctioned : undefined)).error?.data.code).toBe(
            'UNAUTHORIZED',
          );
        expect(await snapshot(f.worldId)).toEqual(before);
      }),
    );

it('T3-07 AC-M3-15 장수 제거와 국가 멸망 뒤에도 과거 순위의 공개 스냅샷과 재생을 보존한다', async () => {
  const alice = await user(),
    fighter = await user(),
    admin = await user(),
    initial = await monthlyFixture();
  await db.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  initial.nations = initial.nations.map((row) => ({ ...row, isNpc: false, gold: 100000 }));
  initial.generals = initial.generals.map((row) => ({
    ...row,
    injury: 0,
    activeFromYear: initial.startYear,
    nextTurnTick: 1_000_000_000,
    rice: 100000,
    train: 100,
    atmos: 100,
  }));
  Object.assign(initial.generals[0]!, { userId: alice.id, cityKey: 1, nextTurnTick: 100, crew: 0 });
  Object.assign(initial.generals[1]!, { userId: null, cityKey: 2, crew: 0, officerLevel: 1 });
  Object.assign(initial.generals[2]!, { userId: fighter.id, cityKey: 1, nextTurnTick: 500, crew: 0 });
  initial.cities.find((row) => row.cityKey === 2)!.wall = 0;
  initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
  syncFixtureMap(initial);
  const { worldId } = await prepareReviewWorld(initial, [
    { generalId: 1, troops: 1 },
    { generalId: 2, troops: 100 },
    { generalId: 3, troops: 7000 },
  ]);
  const setAttack = async (player: Player, generalId: number, cityKey: number) => {
    const actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: generalId } } });
    const result = await rpc(
      'turns.set',
      {
        worldId,
        revision: actor.turnRevision,
        slots: Array.from({ length: 30 }, (_, slot) =>
          slot === 0 ? { commandKey: 'attack', args: { cityKey } } : { commandKey: 'rest', args: {} },
        ),
      },
      player,
    );
    expect(result.status, result.text).toBe(200);
    expect(result.data?.ok).toBe(true);
  };
  await setAttack(alice, 1, 2);
  await setAttack(fighter, 3, 2);
  await advance(worldId, 10000);
  const before = await rpc('review.get', { worldId, year: 191, month: 11 }, fighter);
  expect(before.status, before.text).toBe(200);
  const historical = before.data!.entries.find((entry) => entry.generalId === 2)!;
  const nation = initial.nations.find((row) => row.id === 2)!;
  expect(historical).toMatchObject({
    name: initial.generals[1]!.name,
    score: 1,
    kinds: ['victory', 'defeat'],
    nation: { id: 2, name: nation.name, color: nation.color },
  });
  expect(await db.nation.findUnique({ where: { worldId_id: { worldId, id: 2 } } })).not.toBeNull();
  const removal = await db.inputEvent.create({
    data: {
      worldId,
      userId: admin.id,
      kind: 'admin.general.remove',
      idempotencyKey: `admin.general.remove:${randomUUID()}`,
      payload: {
        version: 1,
        reason: '과거 평판 스냅샷 보존 검증',
        action: { kind: 'admin.general.remove', generalId: 2 },
      },
    },
  });
  await setAttack(fighter, 3, 4);
  await advance(worldId, 20000);
  const removed = await db.inputEvent.findUniqueOrThrow({ where: { id: removal.id } });
  expect(removed.status, JSON.stringify(removed.result)).toBe('APPLIED');
  expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 2 } } })).removedAt).not.toBeNull();
  expect(await db.nation.findUnique({ where: { worldId_id: { worldId, id: 2 } } })).toBeNull();
  expect((await rpc('review.get', { worldId, year: 191, month: 11 }, fighter)).data).toEqual(before.data);
  const archive = await exportReplay(db, worldId);
  if (archive.version !== 3) throw Error('월단평의 재생 형식이 다릅니다.');
  expect(archive.end).not.toBeNull();
  expect(archive.months).toHaveLength(12);
  expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  expect(replayToEnd(archive)).toEqual(archive.end);
  expect(archive.end!.finalStateHash).toBe(hashState(await snapshot(worldId)));
});

it('T3-07 AC-M3-15 정산 전 조회는 비어 있고 손상 JSON은 일반 오류로 거부한다', async () => {
  const off = await fixture(),
    on = await fixture(),
    reader = await user();
  for (const route of ['review.latest', 'review.get', 'review.months'] as const) {
    const input = { worldId: off.worldId, ...(route === 'review.get' ? { year: 191, month: 1 } : {}) };
    expect((await rpc(route, input, reader)).data).toEqual(route === 'review.months' ? [] : null);
  }
  await advance(on.worldId, 10000);
  const key = { worldId_year_month: { worldId: on.worldId, year: 191, month: 1 } };
  await db.monthlyReview.update({ where: key, data: { entries: [{ secret: 'private-corrupt-ledger' }] } });
  for (const route of ['review.latest', 'review.get', 'review.months', 'records.world'] as const) {
    const result = await rpc(
      route,
      { worldId: on.worldId, ...(route === 'review.get' ? { year: 191, month: 1 } : {}) },
      reader,
    );
    expect(result.error?.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(result.text).not.toContain('private-corrupt-ledger');
    expect(result.text).not.toContain('secret');
  }
  await expect(snapshot(on.worldId)).rejects.toThrow();
});

// 합성 지도의 생성 원본에도 변경한 도시 값과 연결을 기록한다.
function syncFixtureMap(initial: Parameters<typeof saveInitialWorld>[1]) {
  const map = initial.operationalMap;
  if (!map) return;
  for (const city of initial.cities) city.connections.sort((a, b) => a - b);
  for (const site of map.sites) {
    if (site.kind !== 'CITY') continue;
    const city = initial.cities.find((row) => row.cityKey === site.anchorKey);
    if (!city) continue;
    site.name = city.name;
    site.level = city.level;
    site.region = city.region;
    site.position = { x: city.x, y: city.y };
    for (const field of ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const) {
      site.initial![field] = city[field];
      site.max![field] = city[`${field}Max`];
    }
  }
  map.routes = initial.cities.flatMap((city) =>
    city.connections
      .filter((key) => city.cityKey < key)
      .map((key) => ({
        id: `route:${city.cityKey}:${key}`,
        from: `city:${city.cityKey}`,
        to: `city:${key}`,
        mode: 'LAND' as const,
        direction: 'BOTH' as const,
        enabled: true,
      })),
  );
}
