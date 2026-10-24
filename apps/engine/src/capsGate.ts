import type { Prisma } from '@opensamguk/db';
import {
  projectTreatyRows,
  selectWorldCapabilities,
  validateBrokenTreatyRow,
  validateClosedTreatyRow,
  type WorldCapabilities,
} from '@opensamguk/rules';
import { checkStoredReplayFormat } from './features';

// 호출자가 확보한 트랜잭션과 World 행을 쓴다. 잠금·쓰기·sequence는 소유하지 않는다.
export async function assertWorldCapabilities(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
): Promise<WorldCapabilities | { kind: 'registry' }> {
  const modern = world.replayFormat === 3;
  checkStoredReplayFormat(world);
  const capabilities = modern ? { kind: 'registry' as const } : selectWorldCapabilities(world);
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
  const enabled = modern
    ? world.ruleFeatures.includes('treaty')
    : capabilities.kind === 'caps' && 'treaty' in capabilities.selection;
  if (!enabled) {
    if (rows.length) throw new Error('조약을 끈 월드에 조약 저장 행이 있습니다.');
  } else {
    const options = { tradeEnabled: modern && world.ruleFeatures.includes('treaty-trade') };
    if (modern)
      for (const row of rows)
        if (!['PROPOSED', 'ACTIVE', 'BROKEN'].includes(row.status)) validateClosedTreatyRow(row, options);
    const broken = rows.filter((row) => row.status === 'BROKEN');
    if (modern && world.ruleFeatures.includes('treaty-break')) {
      for (const row of broken) validateBrokenTreatyRow(row, options);
      projectTreatyRows(
        rows.filter((row) => row.status !== 'BROKEN'),
        options,
      );
    } else projectTreatyRows(rows, options);
  }
  if (modern && !world.ruleFeatures.includes('treaty-break')) {
    const trust = await tx.nationTrust.count({ where: { worldId: world.id } });
    if (trust) throw new Error('조약 파기를 끈 월드에 국가 신뢰 저장 행이 있습니다.');
  }
  return capabilities;
}
