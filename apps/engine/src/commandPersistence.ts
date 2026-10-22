import type { Prisma } from '@opensamguk/db';
import type { CommandResult, WorldState } from '@opensamguk/rules';
import { loadWorld } from './worldLoader';

export async function loadCommandState(
  tx: Prisma.TransactionClient,
  worldId: string,
): Promise<Pick<WorldState, 'commandMeta' | 'nationTurns'>> {
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  const slots = await tx.nationTurn.findMany({ where: { worldId }, orderBy: [{ nationId: 'asc' }, { slot: 'asc' }] });
  const nationTurns: NonNullable<WorldState['nationTurns']> = {};
  for (const slot of slots) {
    nationTurns[slot.nationId] ??= Array.from({ length: 30 }, () => ({ commandKey: 'nation_rest', args: {} }));
    nationTurns[slot.nationId]![slot.slot] = { commandKey: slot.commandKey, args: slot.args };
  }
  return {
    ...(world.commandMeta ? { commandMeta: world.commandMeta as NonNullable<WorldState['commandMeta']> } : {}),
    ...(slots.length ? { nationTurns } : {}),
  };
}

export async function persistCommandState(tx: Prisma.TransactionClient, worldId: string, state: WorldState) {
  const before = await loadWorld(tx, worldId);
  for (const nation of Object.values(state.nations)) {
    if (!before.nations[nation.id]) {
      await tx.nation.create({ data: { ...nation, worldId, capitalCityKey: null } });
    }
  }
  for (const city of Object.values(state.cities)) {
    if (JSON.stringify(city) !== JSON.stringify(before.cities[city.cityKey]))
      await tx.city.update({ where: { worldId_cityKey: { worldId, cityKey: city.cityKey } }, data: city });
  }
  for (const nation of Object.values(state.nations)) {
    if (JSON.stringify(nation) !== JSON.stringify(before.nations[nation.id]))
      await tx.nation.update({ where: { worldId_id: { worldId, id: nation.id } }, data: nation });
  }
  for (const general of Object.values(state.generals)) {
    if (JSON.stringify(general) !== JSON.stringify(before.generals[general.id])) {
      // 장수 턴의 nextTurnTick·revision은 TurnLoop의 조건부 갱신만 바꾼다.
      const { nextTurnTick, ...data } = general;
      void nextTurnTick;
      await tx.general.update({ where: { worldId_id: { worldId, id: general.id } }, data });
    }
  }
  if (JSON.stringify(state.diplomacies) !== JSON.stringify(before.diplomacies)) {
    await tx.diplomacy.deleteMany({ where: { worldId } });
    await tx.diplomacy.createMany({ data: state.diplomacies.map((d) => ({ ...d, worldId })) });
  }
  if (JSON.stringify(state.nationTurns) !== JSON.stringify(before.nationTurns)) {
    await tx.nationTurn.deleteMany({ where: { worldId } });
    await tx.nationTurn.createMany({
      data: Object.entries(state.nationTurns ?? {}).flatMap(([nationId, slots]) =>
        slots.map((slot, i) => ({
          worldId,
          nationId: Number(nationId),
          slot: i,
          commandKey: slot.commandKey,
          args: slot.args as Prisma.InputJsonValue,
        })),
      ),
    });
  }
  if (JSON.stringify(state.commandMeta) !== JSON.stringify(before.commandMeta)) {
    if (state.commandMeta)
      await tx.world.update({
        where: { id: worldId },
        data: { commandMeta: state.commandMeta as Prisma.InputJsonValue },
      });
    else await tx.$executeRaw`UPDATE "World" SET "commandMeta" = NULL WHERE id = ${worldId}`;
  }
  for (const nation of Object.values(before.nations)) {
    if (!state.nations[nation.id]) {
      await tx.nation.update({ where: { worldId_id: { worldId, id: nation.id } }, data: { capitalCityKey: null } });
      await tx.nation.delete({ where: { worldId_id: { worldId, id: nation.id } } });
    }
  }
}

export async function persistCommandReports(
  tx: Prisma.TransactionClient,
  worldId: string,
  tick: number,
  attackerId: number,
  result: CommandResult,
) {
  for (const award of result.battleAwards ?? []) {
    await tx.general.update({
      where: { worldId_id: { worldId, id: award.generalId } },
      data: { battleWins: { increment: award.wins }, captures: { increment: award.captures } },
    });
  }
  await tx.battleLog.createMany({
    data: (result.reports ?? []).map((report) => ({ ...report, worldId, tick, attackerId })),
  });
  for (const entry of result.history ?? []) await appendNationHistory(tx, worldId, tick, entry.nationId, entry.text);
}
export async function appendNationHistory(
  tx: Prisma.TransactionClient,
  worldId: string,
  tick: number,
  nationId: number,
  text: string,
) {
  const where = { worldId_tick_nationId: { worldId, tick, nationId } };
  const previous = await tx.nationHistory.findUnique({ where });
  const data = (previous?.data ?? {}) as Record<string, Prisma.InputJsonValue>;
  const events = Array.isArray(data.events) ? data.events : [];
  await tx.nationHistory.upsert({
    where,
    create: { worldId, tick, nationId, data: { events: [text] } },
    update: { data: { ...data, events: [...events, text] } },
  });
}
