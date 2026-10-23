import type { Prisma } from '@opensamguk/db';
import { projectTreatyRows, selectWorldCapabilities, type WorldCapabilities } from '@opensamguk/rules';

// 호출자가 확보한 트랜잭션과 World 행을 쓴다. 잠금·쓰기·sequence는 소유하지 않는다.
export async function assertWorldCapabilities(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
): Promise<WorldCapabilities> {
  const capabilities = selectWorldCapabilities(world);
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
  if (capabilities.kind !== 'caps' || !('treaty' in capabilities.selection)) {
    if (rows.length) throw new Error('조약을 끈 월드에 조약 저장 행이 있습니다.');
  } else {
    projectTreatyRows(rows);
  }
  return capabilities;
}
