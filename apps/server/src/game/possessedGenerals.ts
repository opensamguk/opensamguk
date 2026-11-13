import type { Prisma } from '@opensamguk/db';
import { POSSESSION_KIND } from '@opensamguk/rules';

export async function possessedGenerals(tx: Prisma.TransactionClient, worldId: string, generalIds: number[]) {
  if (generalIds.length === 0) return new Set<number>();
  const events = await tx.inputEvent.findMany({
    where: { worldId, kind: POSSESSION_KIND, status: 'APPLIED', generalId: { in: generalIds } },
    select: { generalId: true },
  });
  return new Set(events.flatMap(({ generalId }) => (generalId === null ? [] : [generalId])));
}
