import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { buildInitialWorld } from '../packages/rules/src/index';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, assertLease, lockLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { persistEffects } from '../apps/engine/src/persist';
import { persistOfficeState } from '../apps/engine/src/personnelState';

// AC-INT-09 멸망과 직책 저장 순서의 실제 PG 회귀다. 두 군주·시각·군대를 통제해 준비한다.
// 이 고정물은 원생성 archive 재생이나 정식491명 한 기수 인수 증거가 아니다.
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)
) {
  throw new Error('loopback 전용 검사 DB가 필요합니다.');
}
const db = createDb(url),
  worldIds: string[] = [],
  userIds: string[] = [];
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
afterAll(async () => {
  try {
    await db.world.deleteMany({ where: { id: { in: worldIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    await db.$disconnect();
  }
});

async function fixture() {
  const source = operationalInput();
  source.scenario.general[0]![4] = '관문';
  const city = source.map.sites.find((site) => site.kind === 'CITY' && site.anchorKey === 2)!;
  if (city.kind !== 'CITY') throw new Error('검사 도시가 없습니다.');
  city.initial.wall = city.initial.defence = 0;
  const initial = buildInitialWorld(source);
  initial.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'];
  for (const nation of initial.nations) nation.isNpc = false;
  initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
  const { worldId } = await saveInitialWorld(db, initial, {
    name: 'INT09 직책 연쇄 삭제 회귀',
    turnTermMinutes: 60,
    endYear: 201,
  });
  worldIds.push(worldId);
  await controlClock(db, worldId, 'start');
  const user = await db.user.create({
    data: { email: `${randomUUID()}@example.invalid`, passwordHash: 'non-login-office-fixture' },
  });
  userIds.push(user.id);
  await db.general.update({
    where: { worldId_id: { worldId, id: 1 } },
    data: { userId: user.id, rice: 10000, lastActiveTick: 240000, residenceTick: 0, nextTurnTick: 240001 },
  });
  await db.general.update({ where: { worldId_id: { worldId, id: 2 } }, data: { nextTurnTick: 250000 } });
  const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  await db.world.update({
    where: { id: worldId },
    data: {
      status: 'RUNNING',
      clockMode: 'ACCELERATED',
      clockTick: 240000,
      monthlyTick: 240000,
      campaignState: json({
        ...(world.campaignState as object),
        nextUnitId: 2,
        units: [{ id: 1, ownerId: 1, commanderId: 1, crewType: 1100, troops: 2000, train: 100, atmos: 100 }],
      }),
    },
  });
  await db.generalTurn.update({
    where: { worldId_generalId_slot: { worldId, generalId: 1, slot: 0 } },
    data: { commandKey: 'attack', args: { cityKey: 2 }, explicit: true },
  });
  await db.nationOffice.createMany({
    data: [1, 2].map((nationId) => ({ worldId, nationId, officerLevel: 12, turnRevision: 38, tenure: 0 })),
  });
  expect(await db.nationOffice.findMany({ where: { worldId, nationId: 2 } })).toMatchObject([
    { officerLevel: 12, turnRevision: 38, tenure: 0 },
  ]);
  return worldId;
}
async function snapshot(worldId: string) {
  return db.$transaction((tx) => loadReplayState(tx, worldId), { isolationLevel: 'RepeatableRead' });
}

describe('AC-INT-09 국가 멸망과 직책 저장의 원자적 순서', () => {
  it.each([false, true])('충돌=%s에서도 국가 생성 FK·멸망 직책 CAS와 원자성을 지킨다', async (conflict) => {
    const worldId = await fixture(),
      before = await snapshot(worldId),
      after = structuredClone(before.state);
    after.nations[3] = { ...after.nations[2]!, id: 3, name: '새 국가' };
    delete after.nations[2];
    after.diplomacies = [];
    after.cities[2]!.nationId = 3;
    after.generals[2]!.nationId = null;
    after.generals[2]!.officerLevel = 0;
    const lease = await acquireLease(db, worldId);
    if (!lease) throw new Error('검사 실행권이 없습니다.');
    try {
      const writing = db.$transaction(async (tx) => {
        await lockLease(tx, lease);
        await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
        await persistEffects(
          tx,
          worldId,
          after,
          [{ kind: 'world', state: after }],
          { tick: 240001, sequence: 1 },
          before.state,
          async () => {
            expect(await tx.nation.count({ where: { worldId, id: { in: [2, 3] } } })).toBe(2);
            if (conflict)
              await tx.nationOffice.update({
                where: { worldId_nationId_officerLevel: { worldId, nationId: 2, officerLevel: 12 } },
                data: { turnRevision: { increment: 1 } },
              });
            await persistOfficeState(
              tx,
              worldId,
              { offices: before.offices! },
              { offices: { 1: before.offices![1]!, 3: { 12: { revision: 1, tenure: 0 } } } },
            );
          },
        );
        await assertLease(tx, lease);
      });
      if (conflict) await expect(writing).rejects.toThrow('revision 또는 tenure');
      else await writing;
    } finally {
      await releaseLease(db, lease);
    }
    if (conflict) {
      expect(hashState(await snapshot(worldId))).toBe(hashState(before));
      expect(await db.nation.count({ where: { worldId, id: 3 } })).toBe(0);
      expect(await db.removedNation.count({ where: { worldId } })).toBe(0);
    } else {
      expect(await db.nation.count({ where: { worldId, id: 2 } })).toBe(0);
      expect(await db.nationOffice.count({ where: { worldId, nationId: 2 } })).toBe(0);
      expect(
        await db.nationOffice.findUniqueOrThrow({
          where: { worldId_nationId_officerLevel: { worldId, nationId: 3, officerLevel: 12 } },
        }),
      ).toMatchObject({ turnRevision: 1, tenure: 0 });
      expect(await db.removedNation.count({ where: { worldId, nationId: 2 } })).toBe(1);
    }
  });

  it('실제 TurnLoop의 마지막 도시 점령이 직책 CAS·멸망 기록·종료 해시를 함께 저장한다', async () => {
    const worldId = await fixture(),
      otherId = await fixture();
    const isolated = hashState(await snapshot(otherId));
    const lease = await acquireLease(db, worldId);
    if (!lease) throw new Error('검사 실행권이 없습니다.');
    try {
      await new TurnLoop(db, lease).advanceTo(240001);
    } finally {
      await releaseLease(db, lease);
    }
    expect(await db.nation.count({ where: { worldId, id: 2 } })).toBe(0);
    expect(await db.nationOffice.count({ where: { worldId, nationId: 2 } })).toBe(0);
    expect(
      await db.nationOffice.findUniqueOrThrow({
        where: { worldId_nationId_officerLevel: { worldId, nationId: 1, officerLevel: 12 } },
      }),
    ).toMatchObject({ turnRevision: 39, tenure: 0 });
    expect(await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 2 } } })).toMatchObject({
      nationId: 1,
    });
    expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).toMatchObject({
      captures: 1,
      crew: 0,
      cityKey: 2,
    });
    expect(await db.removedNation.count({ where: { worldId, nationId: 2 } })).toBe(1);
    expect(
      await db.generalLog.count({
        where: { worldId, generalId: 1, tick: 240001, commandKey: 'attack', kind: 'success' },
      }),
    ).toBe(1);
    const result = await db.worldResult.findUniqueOrThrow({ where: { worldId } });
    expect(result.reason).toBe('UNIFIED');
    expect(result.finalStateHash).toBe(hashState(await snapshot(worldId)));
    expect(hashState(await snapshot(otherId))).toBe(isolated);
  });

  it('멸망 처리 뒤 commit 직전 실패는 직책·도시·국가·공적·종료·로그를 모두 되돌린다', async () => {
    const worldId = await fixture(),
      before = hashState(await snapshot(worldId));
    const office = await db.nationOffice.findMany({ where: { worldId }, orderBy: { nationId: 'asc' } });
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    const lease = await acquireLease(db, worldId);
    if (!lease) throw new Error('검사 실행권이 없습니다.');
    try {
      await expect(
        new TurnLoop(db, lease, {
          beforeCommit: async () => {
            throw new Error('office-removal-late-rollback');
          },
        }).advanceTo(240001),
      ).rejects.toThrow('office-removal-late-rollback');
    } finally {
      await releaseLease(db, lease);
    }
    expect(hashState(await snapshot(worldId))).toBe(before);
    expect(await db.nationOffice.findMany({ where: { worldId }, orderBy: { nationId: 'asc' } })).toEqual(office);
    expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toEqual(world);
    expect(await db.removedNation.count({ where: { worldId } })).toBe(0);
    expect(await db.worldResult.count({ where: { worldId } })).toBe(0);
    expect(await db.generalLog.count({ where: { worldId } })).toBe(0);
    expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).toMatchObject({
      captures: 0,
      cityKey: 99,
    });
  });
});
