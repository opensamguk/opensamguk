import { expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { saveFixtureWorld } from '../test/worldFixture';
import { loadInitialWorldFromDb } from './world/resources';
import { loadWorldReadRows } from './worldReadRows';
import { loadWorld, loadWorldAfterCapabilityCheck } from './worldLoader';
import { assertWorldCapabilities } from './capsGate';
import { loadOfficeState } from './personnelState';
import { loadPersonnelTurnContext } from './ruleFeatures';
import type { WorldLoadContext } from './features';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');

it('AC-INT-04 한 번 읽은 원장도 기존 reader와 같은 상태를 내고 파손을 거부한다', async () => {
  const db = createDb(url);
  let worldId: string | undefined;
  try {
    const initial = await loadInitialWorldFromDb(db, { scenario: '1030', map: 'che', seed: 'read-rows' });
    ({ worldId } = await saveFixtureWorld(db, initial, { name: 'read rows', turnTermMinutes: 1, endYear: null }));
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      const nation = await tx.nation.findFirstOrThrow({ where: { worldId: worldId! } });
      const office = { worldId: worldId!, nationId: nation.id, officerLevel: 12 };
      await tx.nationOffice.create({ data: office });
      await tx.nationOfficeTurn.create({ data: { ...office, slot: 0, commandKey: 'nation_rest', args: {} } });
      await tx.nationTrust.create({
        data: { worldId: worldId!, nationId: nation.id, brokenTreaties: 1, lastBrokenTick: 0 },
      });
      const rows = await loadWorldReadRows(tx, worldId!);
      expect(rows.offices).toEqual(
        await tx.nationOffice.findMany({
          where: { worldId: worldId! },
          orderBy: [{ nationId: 'asc' }, { officerLevel: 'asc' }],
        }),
      );
      expect(rows.officeTurns).toEqual(
        await tx.nationOfficeTurn.findMany({
          where: { worldId: worldId! },
          orderBy: [{ nationId: 'asc' }, { officerLevel: 'asc' }, { slot: 'asc' }],
        }),
      );
      expect(rows.assignments).toEqual(
        await tx.assignmentOffer.findMany({
          where: { worldId: worldId!, status: 'PENDING' },
          orderBy: [{ targetGeneralId: 'asc' }, { id: 'asc' }],
        }),
      );
      expect(rows.trust).toEqual(
        await tx.nationTrust.findMany({ where: { worldId: worldId! }, orderBy: { nationId: 'asc' } }),
      );
      expect(rows.nationTurns).toEqual(
        await tx.nationTurn.findMany({
          where: { worldId: worldId! },
          orderBy: [{ nationId: 'asc' }, { slot: 'asc' }],
        }),
      );
      expect(rows.slotCount).toBe(491 * 30);
      const before = await loadWorld(tx, worldId!);
      const world = await tx.world.findUniqueOrThrow({ where: { id: worldId! } });
      const context: WorldLoadContext = {};
      const after = await loadWorldAfterCapabilityCheck(tx, world, await assertWorldCapabilities(tx, world), context);
      expect(hashState(after)).toBe(hashState(before));
      expect(context.rows).toEqual(rows);
      expect((await loadPersonnelTurnContext(tx, worldId!, after, context)).offices).toBe(context.offices);
      const badPolicy = structuredClone(context.generals!);
      badPolicy[0]!.defaultPolicy = 'unknown-policy';
      await expect(
        loadPersonnelTurnContext(tx, worldId!, after, { ...context, generals: badPolicy }),
      ).rejects.toThrow();
      const badActivity = structuredClone(context.generals!);
      badActivity[0]!.userId = 'human';
      badActivity[0]!.lastActiveTick = null;
      await expect(
        loadPersonnelTurnContext(tx, worldId!, after, { ...context, generals: badActivity }),
      ).rejects.toThrow();
      const invalidOffice = structuredClone(rows);
      invalidOffice.offices[0]!.tenure = -1;
      await expect(loadOfficeState(tx, worldId!, invalidOffice)).rejects.toThrow();
      await tx.generalTurn.delete({
        where: { worldId_generalId_slot: { worldId: worldId!, generalId: initial.generals.at(-1)!.id, slot: 29 } },
      });
      const incomplete = await loadWorldReadRows(tx, worldId!);
      expect(incomplete.slotCount).toBe(491 * 30 - 1);
      await expect(
        loadPersonnelTurnContext(tx, worldId!, after, { rows: incomplete, generals: context.generals! }),
      ).rejects.toThrow();
    });
  } finally {
    if (worldId) await db.world.delete({ where: { id: worldId! } });
    await db.$disconnect();
  }
});
