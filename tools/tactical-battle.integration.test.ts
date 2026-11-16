import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { testDatabaseUrl } from './test-database';
import { tacticalFixture, testUnits } from '../packages/rules/test/tacticalFixture';
import { persistTacticalTables } from '../apps/engine/src/tacticalBattle';
import {
  closeCouncil,
  resolveBattleTurn,
  tacticalBattleSchema,
  settleTacticalBattle,
} from '../packages/rules/src/index';

const db = createDb(testDatabaseUrl(process.env).href);
let worldId: string | undefined;
beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
});
afterAll(async () => {
  if (worldId) await db.world.delete({ where: { id: worldId } });
  await db.$disconnect();
});
it('AC-INT-28·AC-M1-10 실제 DB 전투 저장·재적재·예약 유일성·rollback과 해제', async () => {
  worldId = `tactical-test-${randomUUID()}`;
  await db.world.create({
    data: {
      id: worldId,
      name: '전술 통합 시험',
      scenarioKey: 'test',
      mapKey: 'test',
      unitSetKey: 'test',
      seed: 'test',
      startYear: 191,
      turnTermMinutes: 60,
      initialStateHash: 'test',
      statRules: {},
      unitSet: JSON.parse(JSON.stringify(testUnits)),
    },
  });
  const { world, battle } = tacticalFixture(),
    before = structuredClone(world);
  delete before.campaign!.tactical;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id=${worldId} FOR UPDATE`;
    await persistTacticalTables(tx, worldId!, before, world, 1);
  });
  const loaded = await db.battle.findUniqueOrThrow({ where: { worldId_id: { worldId, id: battle.id } } });
  expect(tacticalBattleSchema.parse(loaded.state)).toEqual(battle);
  expect(await db.battleReservation.count({ where: { worldId, releasedSequence: null } })).toBeGreaterThan(0);
  await expect(
    db.battleReservation.create({ data: { worldId, key: 'city:2', battleId: battle.id, createdSequence: 2 } }),
  ).rejects.toThrow();
  const previous = structuredClone(world);
  closeCouncil(battle);
  world.campaign!.tactical!.battles[0] = resolveBattleTurn(
    battle,
    battle.units.map((u) => ({ unitId: u.id, action: { kind: 'hold' } })),
    testUnits,
  );
  await expect(
    db.$transaction(async (tx) => {
      await persistTacticalTables(tx, worldId!, previous, world, 2);
      throw Error('injected rollback');
    }),
  ).rejects.toThrow('injected rollback');
  expect(await db.battleTurn.count({ where: { worldId } })).toBe(0);
  await db.$transaction((tx) => persistTacticalTables(tx, worldId!, previous, world, 2));
  expect(await db.battleTurn.count({ where: { worldId } })).toBe(1);
  const last = structuredClone(world),
    ending = world.campaign!.tactical!.battles[0]!;
  ending.phase = 'ended';
  ending.result = 'defend';
  settleTacticalBattle(world, ending);
  await db.$transaction((tx) => persistTacticalTables(tx, worldId!, last, world, 3));
  expect(await db.battleReservation.count({ where: { worldId, releasedSequence: null } })).toBe(0);
  await db.$transaction((tx) => persistTacticalTables(tx, worldId!, world, world, 3));
  expect(await db.battleTurn.count({ where: { worldId } })).toBe(1);
});
