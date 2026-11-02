import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Prisma } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import {
  applyRecordedInput,
  runReplayAction,
  logisticsResultSchema,
  settleLogisticsMonthly,
  type LogisticsConfig,
  type RecordedInput,
  type WorldInit,
  type WorldState,
} from '@opensamguk/rules';
import { loadInitialWorld } from './world/resources';
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
  initial = await loadInitialWorld({
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
async function fixture() {
  const saved = await saveInitialWorld(
    db,
    { ...structuredClone(initial), seed: randomUUID() },
    {
      name: 'AC-P2-30 물류 저장·재생',
      turnTermMinutes: 60,
      endYear: 201,
      replayFormat: 3,
      ruleFeatures: features,
      featureData: { 'logistics-v1': config },
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
});
