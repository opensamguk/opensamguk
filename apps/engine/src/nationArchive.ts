import type { Prisma } from '@opensamguk/db';
import type { WorldState } from '@opensamguk/rules';

export type ActionAt = { sequence: number; tick: number };

export async function archiveRemovedNation(
  tx: Prisma.TransactionClient,
  worldId: string,
  nation: { id: number; name: string; color: string },
  at: ActionAt,
) {
  await tx.removedNation.create({
    data: {
      worldId,
      nationId: nation.id,
      name: nation.name,
      color: nation.color,
      removedSequence: at.sequence,
      removedTick: at.tick,
    },
  });
}

export async function persistYearbookNations(
  tx: Prisma.TransactionClient,
  worldId: string,
  tick: number,
  state: WorldState,
) {
  const data = Object.values(state.nations)
    .sort((a, b) => a.id - b.id)
    .map(({ id, name, color }) => ({ worldId, tick, nationId: id, name, color }));
  if (data.length) await tx.yearbookNation.createMany({ data });
}
