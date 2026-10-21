import type { Prisma } from '@opensamguk/db';
import { emptyTurns, monthlyDate, runMonthly, type ReplayState, type WorldState } from '@opensamguk/rules';
import { rngFor } from '@opensamguk/shared';
import { hashState } from '@opensamguk/shared/node';
import { loadWorld } from './worldLoader';

export async function loadReplayState(tx: Prisma.TransactionClient, worldId: string): Promise<ReplayState> {
  const state = await loadWorld(tx, worldId);
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  const generals = await tx.general.findMany({ where: { worldId } });
  const slots = await tx.generalTurn.findMany({ where: { worldId }, orderBy: { slot: 'asc' } });
  const turns = Object.fromEntries(generals.map(({ id }) => [id, emptyTurns()]));
  for (const slot of slots) turns[slot.generalId]![slot.slot] = { commandKey: slot.commandKey, args: slot.args };
  return {
    state,
    turns,
    revisions: Object.fromEntries(generals.map(({ id, turnRevision }) => [id, turnRevision])),
    monthlyTick: world.monthlyTick,
  };
}

export async function persistMonthly(
  tx: Prisma.TransactionClient,
  worldId: string,
  seed: string,
  tick: number,
  sequence: number,
): Promise<WorldState> {
  const before = await loadWorld(tx, worldId);
  const date = monthlyDate(before.startYear, tick);
  const result = runMonthly(before, tick, rngFor(seed, 'monthly', date.year, date.month));
  const next = result.state;
  // 모든 변경은 같은 리스·월드 잠금을 잡은 트랜잭션 안에서 최종값으로 쓴다.
  for (const city of Object.values(next.cities)) {
    const old = before.cities[city.cityKey]!;
    if (JSON.stringify(city) !== JSON.stringify(old)) {
      await tx.city.update({ where: { worldId_cityKey: { worldId, cityKey: city.cityKey } }, data: city });
    }
  }
  for (const nation of Object.values(next.nations)) {
    if (JSON.stringify(nation) !== JSON.stringify(before.nations[nation.id])) {
      await tx.nation.update({ where: { worldId_id: { worldId, id: nation.id } }, data: nation });
    }
  }
  for (const general of Object.values(next.generals)) {
    if (JSON.stringify(general) !== JSON.stringify(before.generals[general.id])) {
      await tx.general.update({ where: { worldId_id: { worldId, id: general.id } }, data: general });
    }
  }
  await tx.diplomacy.deleteMany({ where: { worldId } });
  await tx.diplomacy.createMany({ data: next.diplomacies.map((entry) => ({ ...entry, worldId })) });
  await tx.world.update({ where: { id: worldId }, data: { monthlyTick: tick } });
  const snapshot = await loadReplayState(tx, worldId);
  await tx.yearbookSnapshot.create({
    data: {
      worldId,
      tick,
      ...date,
      sequence,
      data: result.yearbook as unknown as Prisma.InputJsonValue,
      stateHash: hashState(snapshot),
    },
  });
  await tx.nationHistory.createMany({
    data: result.yearbook.nations.map((nation) => ({
      worldId,
      tick,
      nationId: nation.nationId,
      data: nation as unknown as Prisma.InputJsonValue,
    })),
  });
  return next;
}
