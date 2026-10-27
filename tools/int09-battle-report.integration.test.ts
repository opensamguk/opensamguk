import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it as test } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { rngFor } from '../packages/shared/src/index';
import type { CommandResult } from '../packages/rules/src/index';
import { campaignAttack } from '../packages/rules/src/campaign/attack';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { acquireLease, assertLease, lockLease, releaseLease } from '../apps/engine/src/lease';
import { persistCommandReports } from '../apps/engine/src/commandPersistence';

// AC-INT-09 보고 PK 회귀. 정식491명에서 만든 통제된 교전 스냅샷의 결과를 실제 DB에 쓴다.
// 부대·위치·전쟁을 준비한 이 좁은 검사는 정식 플레이·점령·한 기수 인수 증거가 아니다.
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)
)
  throw new Error('loopback 전용 테스트 DB가 필요합니다.');
const db = createDb(url);
let worldId: string | undefined, attackerId: number, defenderId: number, result: CommandResult;
let preparation: Promise<void> | undefined, execution: Promise<unknown> | undefined;
const it = (name: string, action: () => Promise<void>) => test(name, () => (execution = action()));
beforeEach(async () => {
  await execution?.catch(() => undefined);
});
async function fenced(action: (tx: Prisma.TransactionClient) => Promise<void>) {
  const lease = await acquireLease(db, worldId!);
  if (!lease) throw new Error('검사 실행권이 없습니다.');
  try {
    await db.$transaction(async (tx) => {
      await lockLease(tx, lease);
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId!} FOR UPDATE`;
      await action(tx);
      await assertLease(tx, lease);
    });
  } finally {
    await releaseLease(db, lease);
  }
}
beforeAll(
  () =>
    (preparation = (async () => {
      const initial = await loadInitialWorld({
        scenario: 'integration191',
        map: 'integration',
        statRules: 'five-stats',
        portraitMap: '191-map',
        seed: `int09-report-${randomUUID()}`,
      });
      initial.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'];
      ({ worldId } = await saveInitialWorld(db, initial, { name: 'INT09 보고 키', turnTermMinutes: 60, endYear: 201 }));
      const state = await db.$transaction((tx) => loadWorld(tx, worldId!));
      const from = Object.values(state.cities).find(
        (city) =>
          city.nationId !== null &&
          city.connections.some(
            (id) => state.cities[id]!.nationId !== null && state.cities[id]!.nationId !== city.nationId,
          ),
      )!;
      const target = from.connections
        .map((id) => state.cities[id]!)
        .find((city) => city.nationId !== null && city.nationId !== from.nationId)!;
      const friendly = Object.values(state.generals)
        .filter((general) => general.nationId === from.nationId && general.activeFromYear <= 191)
        .sort((a, b) => b.leadership - a.leadership || a.id - b.id);
      const owner = friendly[0]!,
        commander = friendly[1]!;
      const defender = Object.values(state.generals).find(
        (general) => general.nationId === target.nationId && general.activeFromYear <= 191,
      )!;
      expect(commander.leadership).toBeGreaterThan(10);
      owner.cityKey = commander.cityKey = from.cityKey;
      defender.cityKey = target.cityKey;
      owner.rice = defender.rice = 100000;
      target.wall = target.defence = 0;
      state.diplomacies = [
        {
          nationA: Math.min(from.nationId!, target.nationId!),
          nationB: Math.max(from.nationId!, target.nationId!),
          state: 'WAR',
          untilTick: 0,
        },
      ];
      state.campaign!.links = [{ masterId: owner.id, personId: commander.id, relation: 'LIEUTENANT' }];
      state.campaign!.units = [
        { id: 1, ownerId: owner.id, commanderId: owner.id, troops: 1, crewType: 1100, train: 100, atmos: 100 },
        { id: 2, ownerId: defender.id, commanderId: defender.id, troops: 100, crewType: 1100, train: 100, atmos: 100 },
        { id: 3, ownerId: defender.id, commanderId: defender.id, troops: 10, crewType: 1100, train: 100, atmos: 100 },
        {
          id: 4,
          ownerId: owner.id,
          commanderId: commander.id,
          troops: Math.min(9000, commander.leadership * 100),
          crewType: 1100,
          train: 100,
          atmos: 100,
        },
      ];
      state.campaign!.nextUnitId = 5;
      attackerId = owner.id;
      defenderId = defender.id;
      const actor = { generalId: attackerId, tick: 100, unitSet: initial.unitSet };
      expect(campaignAttack.check(state, actor, { cityKey: target.cityKey })).toBeNull();
      result = campaignAttack.execute(state, actor, { cityKey: target.cityKey }, rngFor('int09-report', 1));
      expect(result.reports).toHaveLength(1);
      expect(result.reports![0]).toMatchObject({ generalId: defenderId, text: expect.stringContaining('부곡1') });
      expect(result.reports![0]!.text).toContain('부곡4');
    })()),
);
afterAll(async () => {
  await preparation?.catch(() => undefined);
  await execution?.catch(() => undefined);
  try {
    if (worldId) await db.world.delete({ where: { id: worldId } });
  } finally {
    await db.$disconnect();
  }
});

it('같은 수비 지휘관의 다부곡·재교전은 BattleLog PK 하나에 모든 교전을 보존한다', async () => {
  const before = await db.general.findMany({
    where: { worldId },
    select: { id: true, battleWins: true, captures: true },
  });
  expect(result.battleAwards!.length).toBeGreaterThan(0);
  expect(result.history!.length).toBeGreaterThan(0);
  await fenced((tx) => persistCommandReports(tx, worldId!, 100, attackerId, result));
  const reports = await db.battleLog.findMany({ where: { worldId, tick: 100, attackerId } });
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ generalId: defenderId, text: result.reports![0]!.text });
  for (const id of new Set(result.battleAwards!.map((award) => award.generalId))) {
    const old = before.find((general) => general.id === id)!;
    const saved = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: worldId!, id } } });
    const awards = result.battleAwards!.filter((award) => award.generalId === id);
    expect(saved.battleWins).toBe(old.battleWins + awards.reduce((sum, award) => sum + award.wins, 0));
    expect(saved.captures).toBe(old.captures + awards.reduce((sum, award) => sum + award.captures, 0));
  }
  for (const entry of result.history!) {
    const history = await db.nationHistory.findUniqueOrThrow({
      where: { worldId_tick_nationId: { worldId: worldId!, tick: 100, nationId: entry.nationId } },
    });
    expect((history.data as { events: string[] }).events).toContain(entry.text);
  }
});
it('중복 보고 키는 DB에서 거부하고 두 번째 저장의 전공 변경도 롤백한다', async () => {
  const before = await db.general.findMany({
    where: { worldId },
    select: { id: true, battleWins: true, captures: true },
    orderBy: { id: 'asc' },
  });
  await expect(fenced((tx) => persistCommandReports(tx, worldId!, 100, attackerId, result))).rejects.toMatchObject({
    code: 'P2002',
  });
  expect(await db.battleLog.count({ where: { worldId } })).toBe(1);
  expect(
    await db.general.findMany({
      where: { worldId },
      select: { id: true, battleWins: true, captures: true },
      orderBy: { id: 'asc' },
    }),
  ).toEqual(before);
});
it('후반 실패는 새 tick의 보고·전공·국가 기록을 함께 롤백한다', async () => {
  const before = await db.nationHistory.findMany({ where: { worldId } });
  const generals = await db.general.findMany({
    where: { worldId },
    select: { id: true, battleWins: true, captures: true },
    orderBy: { id: 'asc' },
  });
  await expect(
    fenced(async (tx) => {
      await persistCommandReports(tx, worldId!, 101, attackerId, result);
      throw new Error('int09 report rollback');
    }),
  ).rejects.toThrow('int09 report rollback');
  expect(await db.battleLog.count({ where: { worldId, tick: 101 } })).toBe(0);
  expect(await db.nationHistory.findMany({ where: { worldId } })).toEqual(before);
  expect(
    await db.general.findMany({
      where: { worldId },
      select: { id: true, battleWins: true, captures: true },
      orderBy: { id: 'asc' },
    }),
  ).toEqual(generals);
});
