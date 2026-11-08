import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Prisma } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { rngFor } from '@opensamguk/shared';
import { z } from 'zod';
import {
  applyRecordedInput,
  runReplayAction,
  logisticsResultSchema,
  logisticsMovementSchema,
  monthlyDate,
  runMonthly,
  settleMonthlyFeatures,
  settleLogisticsMonthly,
  type LogisticsConfig,
  type RecordedInput,
  type WorldInit,
  type WorldState,
} from '@opensamguk/rules';
import { loadInitialWorldFromDb } from './world/resources';
import { saveInitialWorld } from './world/persistence';
import { controlClock } from './world/clock';
import { loadReplayState } from './monthly';
import { acquireLease, releaseLease } from './lease';
import { TurnLoop } from './turnLoop';
import { exportReplay, replayArchive } from './replay';
import {
  appendLogisticsMovements,
  assertStoredLogistics,
  persistLogisticsState,
  readStoredLogistics,
} from './logisticsState';

// AC-P2-30·35: 실제 PG 저장과 조정한 초기 스케줄의 첫 월 재생이다. CF·HTTP·화면 인수는 별도다.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('물류 저장 전용 테스트 DB가 필요합니다.');
const target = new URL(url);
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(target.pathname) ||
  target.searchParams.has('host') ||
  target.searchParams.has('port')
)
  throw new Error('loopback 테스트 DB 주소와 이름을 확인하세요.');
const db = createDb(url),
  ids: string[] = [],
  userIds: string[] = [];
let initial: WorldInit, config: LogisticsConfig;
const features = [
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'five-stats',
  'logistics-v1',
  'operational-map',
  'personnel',
  'policy',
];
beforeAll(async () => {
  initial = await loadInitialWorldFromDb(db, {
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'logistics-storage',
  });
  // 이 스케줄도 원생성에 고정한다. DB를 고쳐서 NPC 차례를 생략하지 않는다.
  initial.generals = initial.generals.map((general) => ({ ...general, crew: 0, nextTurnTick: 1_000_000 }));
  initial.ruleFeatures = [...features];
  const city = initial.cities.find(
    (row) =>
      row.kind !== 'PASS' &&
      row.nationId !== null &&
      row.supplied &&
      initial.cities.some(
        (other) =>
          row.connections.includes(other.cityKey) &&
          other.kind !== 'PASS' &&
          other.nationId === row.nationId &&
          other.supplied,
      ),
  )!;
  config = {
    version: 1,
    specialties: [{ cityKey: city.cityKey, good: 'iron', perMonth: 1000 }],
    capacity: { base: 10_000, perLevel: 10_000, maxLevel: 5 },
    upgrade: { gold: 1000, wood: 500 },
    transport: { maxHops: 8, hopsPerMonth: 2, lossBpPerHop: 100, maxPerOrder: 10_000, maxActivePerNation: 20 },
    recruitPer100: Object.fromEntries(
      [...new Set(initial.unitSet.crewTypes.filter((type) => type.armType > 0).map((type) => type.armType))].map(
        (armType) => [String(armType), { iron: 2, wood: 0, horses: 0 }],
      ),
    ),
    build: { wall: { iron: 0, wood: 50, horses: 0 }, defence: { iron: 20, wood: 20, horses: 0 } },
    trade: { iron: { buy: 3, sell: 1 }, wood: { buy: 3, sell: 1 }, horses: { buy: 3, sell: 1 } },
  };
});
afterAll(async () => {
  try {
    await db.world.deleteMany({ where: { id: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    await db.$disconnect();
  }
});
async function fixture(source = initial, rules = config, seed: string = randomUUID()) {
  const saved = await saveInitialWorld(
    db,
    { ...structuredClone(source), seed },
    {
      name: 'AC-P2-30 물류 저장·재생',
      turnTermMinutes: 60,
      endYear: 201,
      replayFormat: 3,
      ruleFeatures: features,
      featureData: { 'logistics-v1': rules },
    },
  );
  ids.push(saved.worldId);
  const snapshot = await db.$transaction((tx) => loadReplayState(tx, saved.worldId));
  return { id: saved.worldId, before: snapshot.state };
}
async function saveMonth(id: string, before: WorldState, fail = false) {
  const next = settleLogisticsMonthly(before, 10_000);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${id} FOR UPDATE`;
    await persistLogisticsState(tx, id, before, next.state);
    await appendLogisticsMovements(tx, id, next.movements, { tick: 10_000, sequence: 1 });
    await tx.world.update({ where: { id }, data: { monthlyTick: 10_000 } });
    if (fail) throw new Error('after-logistics-save');
  });
  return next;
}

async function advance(id: string, tick: number, client = db, fail = false) {
  const lease = await acquireLease(client, id);
  if (!lease) throw new Error('물류 시험 실행권이 없습니다.');
  try {
    await new TurnLoop(
      client,
      lease,
      fail
        ? {
            beforeCommit: async () => {
              throw new Error('after-queued-save');
            },
          }
        : {},
    ).advanceTo(tick);
  } finally {
    await releaseLease(client, lease);
  }
}

async function queuedFixture() {
  const world = await fixture();
  await controlClock(db, world.id, 'start');
  await advance(world.id, 10_000);
  const source = initial.cities.find((city) => city.cityKey === config.specialties[0]!.cityKey)!;
  const destination = initial.cities.find(
    (city) =>
      source.connections.includes(city.cityKey) &&
      city.kind !== 'PASS' &&
      city.nationId === source.nationId &&
      city.supplied,
  )!;
  const ruler = initial.generals.find(
    (general) => general.nationId === source.nationId && general.officerLevel === 12,
  )!;
  const userId = randomUUID();
  userIds.push(userId);
  await db.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'not-a-login-hash' } });
  // 큐/권한/저장 경계 시험용 바인딩이다. 이 사본 재생을 원생성부터의 사람 생성·임관 인수로 보고하지 않는다.
  await db.general.update({
    where: { worldId_id: { worldId: world.id, id: ruler.id } },
    data: { userId, lastActiveTick: 10_000, lastActiveAt: new Date(), residenceTick: 10_000 },
  });
  const before = await db.$transaction((tx) => loadReplayState(tx, world.id));
  return { ...world, userId, generalId: ruler.id, source: source.cityKey, destination: destination.cityKey, before };
}

// 정식 491명 검증이 아니다. 해당 국가의 군주와 한 NPC만 남겨 모집 경쟁을 원생성에서 고정한다.
async function npcFixture(mode: 'buy' | 'transport', treasuryBudgetBp?: number) {
  const source = structuredClone(initial),
    byCity = new Map(source.cities.map((city) => [city.cityKey, city]));
  const rulers = source.generals.filter(
    (general) => general.userId === null && general.officerLevel === 12 && general.activeFromYear <= source.startYear,
  );
  const eligible = (general: WorldInit['generals'][number], cityKey: number, nationId: number | null) =>
    general.userId === null &&
    general.nationId === nationId &&
    general.cityKey === cityKey &&
    general.officerLevel < 5 &&
    general.activeFromYear <= source.startYear;
  const city = source.cities.find(
    (row) =>
      row.kind !== 'PASS' &&
      row.nationId !== null &&
      row.supplied &&
      row.population >= 100_000 &&
      row.commerce >= 1000 &&
      rulers.some((general) => general.nationId === row.nationId) &&
      source.generals.some((general) => eligible(general, row.cityKey, row.nationId)) &&
      row.connections.some((key) => byCity.get(key)?.nationId !== row.nationId) &&
      row.connections.some(
        (key) =>
          byCity.get(key)?.nationId === row.nationId && byCity.get(key)!.supplied && byCity.get(key)!.kind !== 'PASS',
      ),
  );
  if (!city || city.nationId === null)
    throw new Error('NPC 물류 시험의 부유한 전선·보급 후방·군주·일반 장수가 없습니다.');
  const ruler = rulers.find((general) => general.nationId === city.nationId)!;
  const general = source.generals
    .filter((row) => eligible(row, city.cityKey, city.nationId))
    .sort((a, b) => a.id - b.id)[0]!;
  const rear = city.connections
    .map((key) => byCity.get(key)!)
    .find((row) => row.nationId === city.nationId && row.supplied && row.kind !== 'PASS')!;
  source.generals = source.generals.filter(
    (row) => row.nationId !== city.nationId || row.id === ruler.id || row.id === general.id,
  );
  for (const nation of source.nations) nation.isNpc = nation.id === city.nationId;
  general.nextTurnTick = mode === 'buy' ? 10_010 : 30_010;
  const rules: LogisticsConfig = {
    ...structuredClone(config),
    specialties: mode === 'transport' ? [{ cityKey: rear.cityKey, good: 'iron', perMonth: 1000 }] : [],
    transport: { ...config.transport, lossBpPerHop: 5000 },
    npc: {
      recruitTarget: 100,
      budgetBp: 2000,
      maxActions: 3,
      stockCapBp: 8000,
      upgradeAtBp: 9000,
      ...(treasuryBudgetBp === undefined ? {} : { treasuryBudgetBp }),
    },
  };
  const seed = `npc-logistics-storage-${mode}`,
    saved = await fixture(source, rules, seed);
  return { ...saved, cityKey: city.cityKey, rearKey: rear.cityKey, generalId: general.id, seed };
}
async function queue(world: Awaited<ReturnType<typeof queuedFixture>>, payload: Prisma.InputJsonValue) {
  return db.inputEvent.create({
    data: {
      worldId: world.id,
      userId: world.userId,
      generalId: world.generalId,
      kind: 'logistics.order',
      idempotencyKey: randomUUID(),
      payload,
    },
  });
}
function record(event: Awaited<ReturnType<typeof queue>>): RecordedInput {
  if (event.status === 'PENDING' || event.sequence === null || event.tick === null)
    throw new Error('처리된 큐 기록이 필요합니다.');
  return {
    kind: event.kind,
    generalId: event.generalId,
    payload: event.payload,
    result: event.result,
    status: event.status,
    sequence: event.sequence,
    tick: event.tick,
  };
}

describe('AC-P2-30 실제 PostgreSQL 물류', () => {
  it('큐 수송의 선착순 재고·중복 소비 거부와 실제 도착을 앞사본에서 재생한다', async () => {
    const world = await queuedFixture();
    const amount = world.before.state.logistics!.cities[String(world.source)]!.iron;
    expect(amount).toBeGreaterThan(0);
    const payload = {
      type: 'dispatch',
      fromCityKey: world.source,
      toCityKey: world.destination,
      goods: { iron: amount, wood: 0, horses: 0 },
    };
    const first = await queue(world, payload),
      second = await queue(world, payload);
    await advance(world.id, 10_000);
    const applied = await db.inputEvent.findUniqueOrThrow({ where: { id: first.id } });
    const rejected = await db.inputEvent.findUniqueOrThrow({ where: { id: second.id } });
    expect(applied.status).toBe('APPLIED');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.result).toMatchObject({ code: 'NO_GOODS' });
    const replayed = applyRecordedInput(applyRecordedInput(world.before, record(applied)), record(rejected));
    expect(hashState(await db.$transaction((tx) => loadReplayState(tx, world.id)))).toBe(hashState(replayed));
    const result = logisticsResultSchema.parse(applied.result);
    const reopened = createDb(url);
    try {
      await advance(world.id, result.arriveTick!, reopened);
      const snapshot = await reopened.$transaction((tx) => loadReplayState(tx, world.id));
      expect(snapshot.state.logistics!.convoys).toHaveLength(0);
      expect(snapshot.state.logistics!.cities[String(world.destination)]!.iron).toBeGreaterThan(0);
      const stored = await reopened.world.findUniqueOrThrow({ where: { id: world.id } });
      expect(hashState(snapshot)).toBe(hashState(runReplayAction(replayed, stored.seed, initial.unitSet)));
      await reopened.$transaction((tx) => assertStoredLogistics(tx, stored));
    } finally {
      await reopened.$disconnect();
    }
  });

  it('큐 교역 저장 뒤 실패는 금·재고·원장·입력·순번을 롤백하고 새 엔진이 한 번만 처리한다', async () => {
    const world = await queuedFixture();
    const event = await queue(world, { type: 'trade', cityKey: world.source, good: 'wood', side: 'buy', amount: 2 });
    const clock = await db.world.findUniqueOrThrow({ where: { id: world.id } });
    const count = await db.logisticsMovement.count({ where: { worldId: world.id } });
    await expect(advance(world.id, 10_000, db, true)).rejects.toThrow('after-queued-save');
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: 'PENDING',
      sequence: null,
    });
    expect((await db.world.findUniqueOrThrow({ where: { id: world.id } })).actionSequence).toBe(clock.actionSequence);
    expect(await db.logisticsMovement.count({ where: { worldId: world.id } })).toBe(count);
    expect(hashState(await db.$transaction((tx) => loadReplayState(tx, world.id)))).toBe(hashState(world.before));
    await advance(world.id, 10_000);
    const applied = await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(applied.status).toBe('APPLIED');
    const snapshot = await db.$transaction((tx) => loadReplayState(tx, world.id));
    expect(snapshot.state.logistics!.cities[String(world.source)]!.wood).toBe(2);
    expect(snapshot.state.cityResources!.cities[String(world.source)]!.gold).toBe(
      world.before.state.cityResources!.cities[String(world.source)]!.gold - 6,
    );
    expect(hashState(snapshot)).toBe(hashState(applyRecordedInput(world.before, record(applied))));
    await advance(world.id, 10_000);
    expect(hashState(await db.$transaction((tx) => loadReplayState(tx, world.id)))).toBe(hashState(snapshot));
  });

  it('접수 뒤 권한이 사라진 큐는 재고를 쓰지 않고 거부한다', async () => {
    const world = await queuedFixture();
    const event = await queue(world, { type: 'trade', cityKey: world.source, good: 'wood', side: 'buy', amount: 2 });
    await db.general.update({
      where: { worldId_id: { worldId: world.id, id: world.generalId } },
      data: { officerLevel: 1 },
    });
    const before = await db.$transaction((tx) => loadReplayState(tx, world.id));
    await advance(world.id, 10_000);
    const rejected = await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(rejected).toMatchObject({ status: 'REJECTED', result: { code: 'NO_PERMISSION' } });
    expect(hashState(await db.$transaction((tx) => loadReplayState(tx, world.id)))).toBe(hashState(before));
  });

  it('내보내기 검사는 원장의 삭제를 찾으며 실패한 검사는 기록을 복구한다', async () => {
    const world = await fixture();
    await saveMonth(world.id, world.before);
    await expect(
      db.$transaction(async (tx) => {
        await tx.logisticsMovement.deleteMany({ where: { worldId: world.id } });
        await assertStoredLogistics(tx, await tx.world.findUniqueOrThrow({ where: { id: world.id } }));
      }),
    ).rejects.toThrow('기록');
    await db.$transaction(async (tx) =>
      assertStoredLogistics(tx, await tx.world.findUniqueOrThrow({ where: { id: world.id } })),
    );
  });
  it('실제 새 판 생성에서 빈 재고와 origin의 고정 설정을 만들고 재접속해 읽는다', async () => {
    const world = await fixture(),
      reopened = createDb(url);
    try {
      const row = await reopened.world.findUniqueOrThrow({ where: { id: world.id } });
      expect(readStoredLogistics(row.logisticsState, world.before, config)).toEqual(world.before.logistics);
      expect(
        Object.values(world.before.logistics!.cities).every((city) => city.iron + city.wood + city.horses === 0),
      ).toBe(true);
    } finally {
      await reopened.$disconnect();
    }
  });

  it('후속 실패는 재고·원장·월 tick을 모두 롤백하고 다른 월드에 영향을 주지 않는다', async () => {
    const world = await fixture(),
      other = await fixture();
    await expect(saveMonth(world.id, world.before, true)).rejects.toThrow('after-logistics-save');
    expect((await db.world.findUniqueOrThrow({ where: { id: world.id } })).logisticsState).toEqual(
      world.before.logistics,
    );
    expect(await db.logisticsMovement.count({ where: { worldId: world.id } })).toBe(0);
    expect((await db.world.findUniqueOrThrow({ where: { id: world.id } })).monthlyTick).toBe(0);
    expect((await db.world.findUniqueOrThrow({ where: { id: other.id } })).logisticsState).toEqual(
      other.before.logistics,
    );
  });

  it('같은 이전 상태의 동시 쓰기는 하나만 반영하고 재접속 후에도 원장과 재고가 일치한다', async () => {
    const world = await fixture();
    const results = await Promise.allSettled([saveMonth(world.id, world.before), saveMonth(world.id, world.before)]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const reopened = createDb(url);
    try {
      const snapshot = await reopened.$transaction((tx) => loadReplayState(tx, world.id));
      const rows = await reopened.logisticsMovement.findMany({ where: { worldId: world.id } });
      expect(rows.reduce((sum, row) => sum + row.delta, 0)).toBe(
        snapshot.state.logistics!.cities[String(config.specialties[0]!.cityKey)]!.iron,
      );
      expect(snapshot.state.logistics!.monthlyTick).toBe(10_000);
    } finally {
      await reopened.$disconnect();
    }
  });

  it('DB와 로드 경계가 기능·상태 누락과 origin 설정 변경을 거부한다', async () => {
    const world = await fixture();
    await expect(db.$executeRaw`UPDATE "World" SET "logisticsState" = NULL WHERE id = ${world.id}`).rejects.toThrow();
    await expect(
      db.world.update({
        where: { id: world.id },
        data: { ruleFeatures: features.filter((key) => key !== 'logistics-v1') },
      }),
    ).rejects.toThrow();
    const corrupted = structuredClone(world.before.logistics!);
    corrupted.config.transport.maxHops--;
    expect(() => readStoredLogistics(corrupted, world.before, config)).toThrow('원생성');
  });

  it('실제 엔진의 첫 월 생산·기록을 원생성에서 다시 재생해 DB 해시와 대조한다', async () => {
    const world = await fixture();
    await controlClock(db, world.id, 'start');
    const lease = await acquireLease(db, world.id);
    if (!lease) throw new Error('물류 시험 실행권이 없습니다.');
    try {
      await new TurnLoop(db, lease).advanceTo(10_000);
    } finally {
      await releaseLease(db, lease);
    }
    const snapshot = await db.$transaction((tx) => loadReplayState(tx, world.id));
    expect(snapshot.state.logistics!.cities[String(config.specialties[0]!.cityKey)]!.iron).toBeGreaterThan(0);
    expect(await db.logisticsMovement.count({ where: { worldId: world.id } })).toBeGreaterThan(0);
    const archive = await exportReplay(db, world.id),
      replayed = replayArchive(archive, 1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.stateHash).toBe(hashState(snapshot));
    expect(replayArchive(archive, 1)).toEqual(replayed);
  });

  it('NPC 월 매입의 저장 뒤 실패를 롤백하고 재접속한 실제 NPC가 모집·소비한 결과를 재생한다', async () => {
    const world = await npcFixture('buy'),
      other = await fixture();
    await controlClock(db, world.id, 'start');
    const before = await db.$transaction((tx) => loadReplayState(tx, world.id));
    const date = monthlyDate(before.state.startYear, 10_000);
    const base = runMonthly(before.state, 10_000, rngFor(world.seed, 'monthly', date.year, date.month));
    const expected = settleMonthlyFeatures(before, { ...before, state: base.state, monthlyTick: 10_000 }, 10_000);
    const expectedRows = z
      .strictObject({ movements: z.array(logisticsMovementSchema) })
      .parse(expected.effects['logistics-v1']).movements;
    const lease = await acquireLease(db, world.id);
    if (!lease) throw new Error('NPC 롤백 시험 실행권이 없습니다.');
    let observed = 0;
    try {
      await expect(
        new TurnLoop(db, lease, {
          beforeCommit: async (tx) => {
            const count = await tx.logisticsMovement.count({
              where: { worldId: world.id, tick: 10_000, reason: 'TRADE', holder: 'city', holderId: world.cityKey },
            });
            if (!count) return;
            observed = count;
            throw new Error('after-npc-month-save');
          },
        }).advanceTo(10_000),
      ).rejects.toThrow('after-npc-month-save');
    } finally {
      await releaseLease(db, lease);
    }
    expect(observed).toBeGreaterThan(0);
    const rolledBack = await db.$transaction((tx) => loadReplayState(tx, world.id));
    expect(rolledBack.state).toEqual(before.state);
    expect(rolledBack.monthlyTick).toBe(0);
    expect(await db.logisticsMovement.count({ where: { worldId: world.id } })).toBe(0);
    expect(await db.yearbookSnapshot.count({ where: { worldId: world.id } })).toBe(0);
    expect((await db.$transaction((tx) => loadReplayState(tx, other.id))).state).toEqual(other.before);
    const reopened = createDb(url);
    try {
      await advance(world.id, 10_000, reopened);
    } finally {
      await reopened.$disconnect();
    }
    const purchased = await db.$transaction((tx) => loadReplayState(tx, world.id));
    expect(hashState(purchased)).toBe(hashState(expected.replay));
    const rows = await db.logisticsMovement.findMany({
      where: { worldId: world.id, tick: 10_000 },
      orderBy: [{ sequence: 'asc' }, { ordinal: 'asc' }],
    });
    expect(
      rows.map(({ holder, holderId, good, delta, reason }) => ({ holder, id: holderId, good, delta, reason })),
    ).toEqual(expectedRows);
    expect(rows.map((row) => row.ordinal)).toEqual(expectedRows.map((_, ordinal) => ordinal));
    expect(purchased.state.logistics!.cities[String(world.cityKey)]!.iron).toBe(2);
    await advance(world.id, 10_010);
    const recruited = await db.$transaction((tx) => loadReplayState(tx, world.id));
    expect(
      await db.generalLog.findMany({
        where: { worldId: world.id, generalId: world.generalId, tick: 10_010 },
        select: { commandKey: true, kind: true, text: true },
      }),
    ).toContainEqual(expect.objectContaining({ commandKey: 'recruit' }));
    const troops = recruited.state.cityResources!.cities[String(world.cityKey)]!.garrison.reduce(
      (total, row) => total + row.troops,
      0,
    );
    expect(troops).toBeGreaterThan(0);
    expect(troops).toBeLessThanOrEqual(100);
    expect(recruited.state.cities[world.cityKey]!.population).toBe(
      purchased.state.cities[world.cityKey]!.population - troops,
    );
    expect(recruited.state.generals[world.generalId]!.gold).toBe(purchased.state.generals[world.generalId]!.gold);
    expect(recruited.state.logistics!.cities[String(world.cityKey)]!.iron).toBe(0);
    expect(
      await db.logisticsMovement.findFirst({
        where: {
          worldId: world.id,
          tick: 10_010,
          holder: 'city',
          holderId: world.cityKey,
          good: 'iron',
          reason: 'CONSUME',
          delta: -2,
        },
      }),
    ).not.toBeNull();
    await advance(world.id, 20_000);
    const final = await db.$transaction((tx) => loadReplayState(tx, world.id)),
      archive = await exportReplay(db, world.id);
    const replayed = replayArchive(archive, 2);
    expect(replayed).toHaveLength(2);
    expect(replayed.at(-1)!.stateHash).toBe(hashState(final));
    expect(replayArchive(archive, 2)).toEqual(replayed);
  });

  it('국고 10% 상한을 설정한 실제 NPC 월 교역의 비용과 설정을 저장하고 재생한다', async () => {
    const world = await npcFixture('buy', 1000);
    const city = world.before.cities[world.cityKey]!;
    const nationId = city.nationId!;
    const date = monthlyDate(world.before.startYear, 10_000);
    const base = runMonthly(world.before, 10_000, rngFor(world.seed, 'monthly', date.year, date.month)).state;
    await controlClock(db, world.id, 'start');
    await advance(world.id, 10_000);
    const stored = await db.$transaction((tx) => loadReplayState(tx, world.id));
    const rows = await db.logisticsMovement.findMany({ where: { worldId: world.id, tick: 10_000, reason: 'TRADE' } });
    expect(rows).toMatchObject([{ holder: 'city', holderId: world.cityKey, good: 'iron', delta: 2 }]);
    const expense =
      base.cityResources!.cities[world.cityKey]!.gold - stored.state.cityResources!.cities[world.cityKey]!.gold;
    expect(expense).toBe(2 * config.trade.iron.buy);
    expect(expense).toBeLessThanOrEqual(Math.floor(base.nations[nationId]!.gold / 10));
    expect(stored.state.nations[nationId]!.gold).toBe(base.nations[nationId]!.gold);
    expect(stored.state.logistics!.config.npc?.treasuryBudgetBp).toBe(1000);
    const archive = await exportReplay(db, world.id);
    expect(replayArchive(archive, 1)[0]!.stateHash).toBe(hashState(stored));
  });

  it('NPC 특산 후방의 실제 수송·도착 손실·보충·모집 원장을 네 달 재생과 대조한다', async () => {
    const world = await npcFixture('transport');
    await controlClock(db, world.id, 'start');
    await advance(world.id, 10_000);
    const sent = await db.$transaction((tx) => loadReplayState(tx, world.id));
    expect(sent.state.logistics!.convoys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromCityKey: world.rearKey,
          toCityKey: world.cityKey,
          goods: { iron: 2, wood: 0, horses: 0 },
        }),
      ]),
    );
    await advance(world.id, 20_000);
    expect(
      await db.logisticsMovement.findFirst({
        where: { worldId: world.id, reason: 'LOSS_TRANSIT', good: 'iron', delta: -1 },
      }),
    ).not.toBeNull();
    expect(
      await db.logisticsMovement.findFirst({
        where: {
          worldId: world.id,
          tick: 20_000,
          reason: 'ARRIVE',
          holder: 'city',
          holderId: world.cityKey,
          good: 'iron',
          delta: 1,
        },
      }),
    ).not.toBeNull();
    await advance(world.id, 30_010);
    const recruited = await db.$transaction((tx) => loadReplayState(tx, world.id));
    expect(
      await db.generalLog.findMany({
        where: { worldId: world.id, generalId: world.generalId, tick: 30_010 },
        select: { commandKey: true, kind: true, text: true },
      }),
    ).toContainEqual(expect.objectContaining({ commandKey: 'recruit' }));
    expect(
      recruited.state.cityResources!.cities[String(world.cityKey)]!.garrison.reduce(
        (total, row) => total + row.troops,
        0,
      ),
    ).toBeGreaterThan(0);
    expect(
      await db.logisticsMovement.findFirst({
        where: {
          worldId: world.id,
          tick: 30_010,
          reason: 'CONSUME',
          holder: 'city',
          holderId: world.cityKey,
          delta: -2,
        },
      }),
    ).not.toBeNull();
    await advance(world.id, 40_000);
    const final = await db.$transaction((tx) => loadReplayState(tx, world.id)),
      archive = await exportReplay(db, world.id);
    const replayed = replayArchive(archive, 4);
    expect(replayed).toHaveLength(4);
    expect(replayed.at(-1)!.stateHash).toBe(hashState(final));
    expect(replayArchive(archive, 4)).toEqual(replayed);
  });
});
