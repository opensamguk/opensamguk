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

// 직책·장수 등 후속 상태를 저장한 뒤 같은 잠긴 트랜잭션에서 호출한다.
export async function persistRemovedNations(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldState,
  next: WorldState,
  at: ActionAt,
) {
  for (const nation of Object.values(before.nations)) {
    if (next.nations[nation.id]) continue;
    await archiveRemovedNation(tx, worldId, nation, at);
    await tx.nation.update({ where: { worldId_id: { worldId, id: nation.id } }, data: { capitalCityKey: null } });
    await tx.nation.delete({ where: { worldId_id: { worldId, id: nation.id } } });
  }
}
