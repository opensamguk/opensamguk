import { notifyActivityOnCommit, type Prisma } from '@opensamguk/db';
import { COURT_PROMOTION_FEATURE, nationRank, type WorldState } from '@opensamguk/rules';

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
    const prior = before.nations[nation.id];
    if (!prior) data.push({ kind: 'found', text: `${nation.name} 건국` });
    else if (next.ruleFeatures?.includes(COURT_PROMOTION_FEATURE) && prior.level < nation.level) {
      const title = nationRank(nation.level)?.title;
      if (title) data.push({ kind: 'promotion', text: `${nation.name} 작위 승급 · ${title}` });
    }
  }
  for (const nation of Object.values(before.nations)) {
    if (!next.nations[nation.id]) data.push({ kind: 'fall', text: `${nation.name} 멸망` });
  }
  for (const general of Object.values(next.generals)) {
    const prior = before.generals[general.id];
    if (!prior || general.nationId === null || prior.nationId === general.nationId) continue;
    const nation = before.nations[general.nationId];
    if (nation && next.nations[nation.id]) data.push({ kind: 'enlist', text: `${general.name} ${nation.name} 임관` });
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
  nations: readonly { id: number; name: string; color: string; power: number }[],
) {
  const data = nations.map(({ id, name, color, power }) => ({ worldId, tick, nationId: id, name, color, power }));
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
