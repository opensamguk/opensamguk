import type { Prisma } from '@opensamguk/db';
import { assignmentRejectCost, ASSIGNMENT_REJECT_PERCENT, toGameDate, TICKS_PER_MONTH } from '@opensamguk/rules';
import { requireGeneral, requireWorld } from './queries';
import { requirePersonnelWorld } from './personnelAdmission';

export async function readMyAssignmentOffers(tx: Prisma.TransactionClient, worldId: string, userId: string) {
  const world = await requireWorld(tx, worldId);
  requirePersonnelWorld(world);
  const actor = await requireGeneral(tx, worldId, userId);
  const rows = await tx.assignmentOffer.findMany({
    where: { worldId, targetGeneralId: actor.id, status: 'PENDING' },
    orderBy: { id: 'asc' },
  });
  const items = [];
  for (const row of rows) {
    const issuer = await tx.general.findUniqueOrThrow({
      where: { worldId_id: { worldId, id: row.issuerGeneralId } },
      select: { id: true, name: true },
    });
    const city = await tx.city.findUniqueOrThrow({
      where: { worldId_cityKey: { worldId, cityKey: row.cityKey } },
      select: { cityKey: true, name: true },
    });
    const pending = await tx.inputEvent.findFirst({
      where: { worldId, kind: 'offer.respond', status: 'PENDING', payload: { path: ['offerId'], equals: row.id } },
      select: { id: true },
    });
    items.push({
      id: row.id,
      issuer: { generalId: issuer.id, name: issuer.name },
      targetCity: city,
      expires: {
        ...toGameDate(world.startYear, row.expiresTick),
        monthsLeft: Math.max(0, Math.ceil((row.expiresTick - world.monthlyTick) / TICKS_PER_MONTH)),
      },
      rejectCost: { dedicationPercent: ASSIGNMENT_REJECT_PERCENT, dedication: assignmentRejectCost(actor.dedication) },
      respond: pending ? { ok: false as const, reason: '응답을 처리하는 중입니다.' } : { ok: true as const },
    });
  }
  return items;
}
