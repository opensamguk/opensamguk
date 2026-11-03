import { z } from 'zod';
import { GOVERNANCE_OFFICES } from '../governance/config';
import { reconcileGovernance } from '../governance/reconcile';
import type { WorldView } from '../model/world';
import { assignmentCancelReason } from '../personnel/assignments';
import { lineageId, lineageQuantity } from './config';
import { applySuccession } from './succession';

export const successionPreviewSchema = z.strictObject({
  heirId: lineageId,
  officerLevel: lineageQuantity.max(12),
  gold: lineageQuantity,
  rice: lineageQuantity,
  crew: lineageQuantity,
  unitIds: z.array(lineageId),
  keptRetinue: z.array(lineageId),
  releasedRetinue: z.array(lineageId),
  cancelledOrders: z.array(lineageId),
  cancelledOffers: z.array(z.strictObject({ kind: z.enum(['RETINUE', 'ASSIGNMENT']), id: z.string().min(1).max(200) })),
  governance: z.strictObject({
    throne: z.boolean(),
    courtOffice: z.enum(GOVERNANCE_OFFICES).nullable(),
    vassalIds: z.array(lineageId),
  }),
});
export type SuccessionPreview = z.infer<typeof successionPreviewSchema>;

export function successionPreview(world: WorldView, fromId: number, heirId: number, tick: number) {
  const outcome = applySuccession(world, fromId, heirId, 'HUMAN', tick);
  if (!outcome.ok) return outcome;
  const next = outcome.world,
    to = next.generals[heirId]!;
  const units = (next.campaign?.units ?? []).filter((unit) => unit.ownerId === heirId).sort((a, b) => a.id - b.id);
  const released = new Set(outcome.releasedPeople);
  for (const link of world.campaign?.links ?? [])
    if (
      (link.personId === fromId || link.personId === heirId) &&
      !next.campaign?.links.some((row) => row.personId === link.personId)
    )
      released.add(link.personId);
  const cancelledOrders = (world.campaign?.orders?.items ?? [])
    .filter(
      (order) =>
        (order.status === 'PENDING' || order.status === 'READY') &&
        next.campaign?.orders?.items.some((row) => row.id === order.id && row.status === 'CANCELLED'),
    )
    .map((order) => order.id)
    .sort((a, b) => a - b);
  const cancelledOffers: SuccessionPreview['cancelledOffers'] = (world.campaign?.offers ?? [])
    .filter(
      (offer) =>
        offer.status === 'PENDING' &&
        next.campaign?.offers.some((row) => row.id === offer.id && row.status === 'CANCELLED'),
    )
    .map((offer) => ({ kind: 'RETINUE', id: String(offer.id) }));
  for (const [target, offer] of Object.entries(world.assignmentOffers ?? {}))
    if (!assignmentCancelReason(world, Number(target), offer) && assignmentCancelReason(next, Number(target), offer))
      cancelledOffers.push({ kind: 'ASSIGNMENT', id: offer.id });
  cancelledOffers.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let throne = false,
    courtOffice: SuccessionPreview['governance']['courtOffice'] = null;
  let vassalIds: number[] = [];
  if (world.governance) {
    const before = reconcileGovernance(world, tick).governance!,
      after = reconcileGovernance(next, tick).governance!;
    throne = before.throne.emperorGeneralId === fromId && after.throne.emperorGeneralId !== fromId;
    courtOffice =
      GOVERNANCE_OFFICES.find(
        (role) => before.court[role]?.generalId === fromId && after.court[role]?.generalId !== fromId,
      ) ?? null;
    const remaining = new Set(after.vassals.map((row) => row.id));
    vassalIds = before.vassals
      .filter((row) => !remaining.has(row.id))
      .map((row) => row.id)
      .sort((a, b) => a - b);
  }
  const value = successionPreviewSchema.parse({
    heirId,
    officerLevel: to.officerLevel,
    gold: to.gold,
    rice: to.rice,
    crew: to.crew + units.reduce((sum, unit) => sum + unit.troops, 0),
    unitIds: units.map((unit) => unit.id),
    keptRetinue: [...outcome.inheritedPeople].sort((a, b) => a - b),
    releasedRetinue: [...released].sort((a, b) => a - b),
    cancelledOrders,
    cancelledOffers,
    governance: { throne, courtOffice, vassalIds },
  });
  return { ok: true as const, value };
}
