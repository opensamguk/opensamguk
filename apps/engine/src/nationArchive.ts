import { notifyActivityOnCommit, type Prisma } from '@opensamguk/db';
import type { WorldState } from '@opensamguk/rules';

export type ActionAt = { sequence: number; tick: number };

export async function persistPublicNationEvents(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldState,
  next: WorldState,
  at: ActionAt,
) {
  const data: { kind: string; text: string }[] = [];
  for (const nation of Object.values(next.nations)) {
    if (!before.nations[nation.id]) data.push({ kind: 'found', text: `${nation.name} 건국` });
  }
  for (const nation of Object.values(before.nations)) {
    if (!next.nations[nation.id]) data.push({ kind: 'fall', text: `${nation.name} 멸망` });
  }
  for (const city of Object.values(next.cities)) {
    const previous = before.cities[city.cityKey]?.nationId;
    const owner = city.nationId === null ? undefined : next.nations[city.nationId];
    if (previous !== undefined && previous !== city.nationId && owner && before.nations[owner.id])
      data.push({ kind: 'capture', text: `${owner.name}의 ${city.name} 점령` });
  }
  if (before.diplomacies !== next.diplomacies) {
    const prior = new Set(
      before.diplomacies
        .filter(({ state }) => state === 'DECLARED')
        .map(({ nationA, nationB }) => `${nationA}:${nationB}`),
    );
    for (const { nationA, nationB, state } of next.diplomacies) {
      if (state !== 'DECLARED' || prior.has(`${nationA}:${nationB}`)) continue;
      const a = next.nations[nationA],
        b = next.nations[nationB];
      if (a && b) data.push({ kind: 'declare', text: `${a.name}·${b.name} 사이 선전포고` });
    }
  }
  if (data.length) {
    await tx.publicNationEvent.createMany({ data: data.map((event) => ({ ...event, worldId, ...at })) });
    await notifyActivityOnCommit(tx, worldId);
  }
}

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
