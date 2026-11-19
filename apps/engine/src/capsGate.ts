import type { Prisma } from '@opensamguk/db';
import {
  projectTreatyRows,
  treatyOptions,
  selectWorldCapabilities,
  readStoredNationStrategy,
  readStoredPreparedTurns,
  readStoredNationResearch,
  readStoredNationLifecycle,
  validateBrokenTreatyRow,
  validateClosedTreatyRow,
  type WorldCapabilities,
} from '@opensamguk/rules';
import { checkStoredReplayFormat, type checkWorldReplay } from './features';
import { assertStoredCityResources } from './cityResourcesState';
import { assertStoredCityRuins } from './cityScaleState';
import { assertStoredLogistics } from './logisticsState';
import { readCampaignArmyTypes } from './campaignState';

// 호출자가 확보한 트랜잭션과 World 행을 쓴다. 잠금·쓰기·sequence는 소유하지 않는다.
export async function assertWorldCapabilities(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
): Promise<
  | WorldCapabilities
  | {
      kind: 'registry';
      armyTypes?: readonly number[];
      origin: ReturnType<typeof checkWorldReplay>;
      cities: Prisma.CityGetPayload<Record<string, never>>[];
      treaties: readonly Omit<Prisma.TreatyGetPayload<Record<string, never>>, 'worldId'>[];
    }
> {
  const modern = world.replayFormat === 3;
  const origin = checkStoredReplayFormat(world);
  readStoredNationStrategy(world, origin);
  readStoredPreparedTurns(world, origin);
  readStoredNationResearch(world, origin);
  readStoredNationLifecycle(world, origin);
  const armyTypes = readCampaignArmyTypes(world, origin);
  const cities = await tx.city.findMany({ where: { worldId: world.id } });
  await assertStoredCityResources(tx, world, armyTypes, cities);
  await assertStoredCityRuins(tx, world, origin, cities);
  await assertStoredLogistics(tx, world, cities);
  const capabilities = modern
    ? { kind: 'registry' as const, armyTypes, origin, cities }
    : selectWorldCapabilities(world);
  const rows = await tx.treaty.findMany({
    where: { worldId: world.id },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      fromNationId: true,
      toNationId: true,
      clauses: true,
      status: true,
      proposedTick: true,
      respondByTick: true,
      startTick: true,
      endTick: true,
      costFrom: true,
      costTo: true,
      closedSequence: true,
    },
  });
  const enabled = modern ? true : capabilities.kind === 'caps' && 'treaty' in capabilities.selection;
  if (!enabled) {
    if (rows.length) throw new Error('조약을 끈 월드에 조약 저장 행이 있습니다.');
  } else {
    const options = treatyOptions();
    if (modern)
      for (const row of rows)
        if (!['PROPOSED', 'ACTIVE', 'BROKEN'].includes(row.status)) validateClosedTreatyRow(row, options);
    const broken = rows.filter((row) => row.status === 'BROKEN');
    if (modern) {
      for (const row of broken) validateBrokenTreatyRow(row, options);
      projectTreatyRows(
        rows.filter((row) => row.status !== 'BROKEN'),
        options,
      );
    } else projectTreatyRows(rows, options);
  }
  return capabilities.kind === 'registry' ? { ...capabilities, treaties: rows } : capabilities;
}
