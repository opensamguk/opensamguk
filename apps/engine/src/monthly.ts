import type { Prisma } from '@opensamguk/db';
import { emptyTurns, monthlyDate, runMonthly, type ReplayState, type WorldState } from '@opensamguk/rules';
import { rngFor } from '@opensamguk/shared';
import { hashState } from '@opensamguk/shared/node';
import { engineFeatures } from './features';
import { loadWorld } from './worldLoader';
import { persistRanking } from './ranking';
import { persistYearbookNations } from './nationArchive';

export async function loadReplayState(tx: Prisma.TransactionClient, worldId: string): Promise<ReplayState> {
  const state = await loadWorld(tx, worldId);
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId }, select: { monthlyTick: true } });
  const generals = await tx.general.findMany({ where: { worldId } });
  const slots = await tx.generalTurn.findMany({ where: { worldId }, orderBy: { slot: 'asc' } });
  const turns = Object.fromEntries(generals.map(({ id }) => [id, emptyTurns()]));
  for (const slot of slots) turns[slot.generalId]![slot.slot] = { commandKey: slot.commandKey, args: slot.args };
  let replay: ReplayState = {
    state,
    turns,
    revisions: Object.fromEntries(generals.map(({ id, turnRevision }) => [id, turnRevision])),
    monthlyTick: world.monthlyTick,
  };
  for (const feature of engineFeatures
    .filter((feature) => state.ruleFeatures?.includes(feature.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
    replay = (await feature.loadReplayState?.(tx, worldId, replay)) ?? replay;
  return replay;
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
  for (const feature of engineFeatures
    .filter((feature) => next.ruleFeatures?.includes(feature.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
    await feature.persistMonthly?.(tx, worldId, before, next);
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
  await persistYearbookNations(tx, worldId, tick, next);
  for (const nation of result.yearbook.nations) {
    const where = { worldId_tick_nationId: { worldId, tick, nationId: nation.nationId } };
    // 같은 월드 잠금 안에서 기존 사건을 보존하고 월간 수치를 덧붙인다.
    const previous = await tx.nationHistory.findUnique({ where });
    const data = { ...(previous?.data as Prisma.JsonObject | undefined), ...nation } as Prisma.InputJsonValue;
    await tx.nationHistory.upsert({
      where,
      create: { worldId, tick, nationId: nation.nationId, data },
      update: { data },
    });
  }
  await persistRanking(tx, worldId, next, seed, { tick, ...date });
  return next;
}
