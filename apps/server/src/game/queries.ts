import { TRPCError } from '@trpc/server';
import { readWorldExtRows, type Prisma } from '@opensamguk/db';
import {
  toWorldState,
  presetRules,
  restoreExtState,
  selectWorldCapabilities,
  projectTreatyRows,
  type WorldInit,
} from '@opensamguk/rules';
import { z } from 'zod';
import { worldResolver } from './resolver';
export const worldInput = z.strictObject({ worldId: z.string().min(1).max(64) });
export async function requireWorld(tx: Prisma.TransactionClient, worldId: string, lock = false) {
  if (lock) await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
  const world = await tx.world.findUnique({ where: { id: worldId } });
  if (!world) throw new TRPCError({ code: 'NOT_FOUND', message: '월드가 없습니다.' });
  return world;
}
export async function requireGeneral(tx: Prisma.TransactionClient, worldId: string, userId: string, lock = false) {
  if (lock)
    await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${worldId} AND "userId" = ${userId} FOR UPDATE`;
  const general = await tx.general.findUnique({ where: { worldId_userId: { worldId, userId } } });
  if (!general) throw new TRPCError({ code: 'NOT_FOUND', message: '장수가 없습니다.' });
  return general;
}
export async function readView(tx: Prisma.TransactionClient, worldId: string) {
  const world = await requireWorld(tx, worldId);
  const { preset, commands } = worldResolver(world);
  const capabilities = selectWorldCapabilities(world);
  const treatyRows = await tx.treaty.findMany({
    where: { worldId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      fromNationId: true,
      toNationId: true,
      clauses: true,
      status: true,
      proposedTick: true,
      respondByTick: true,
      startTick: true,
      endTick: true,
      costFrom: true,
      costTo: true,
      closedSequence: true,
    },
  });
  if (capabilities.kind === 'legacy' && treatyRows.length) throw new Error('조약을 끈 월드에 조약 저장 행이 있습니다.');
  const treaties = capabilities.kind === 'caps' ? projectTreatyRows(treatyRows) : undefined;
  const ext = restoreExtState(commands, await readWorldExtRows(tx, worldId));
  const cities = await tx.city.findMany({ where: { worldId } });
  const nations = await tx.nation.findMany({ where: { worldId } });
  const generals = await tx.general.findMany({
    where: { worldId },
    omit: { defaultPolicy: true, lastActiveTick: true, lastActiveAt: true },
  });
  const diplomacies = await tx.diplomacy.findMany({ where: { worldId } });
  const state = toWorldState({
    ...(preset ? { presetRules: presetRules(preset) } : {}),
    ...(ext ? { ext } : {}),
    startYear: world.startYear,
    cities,
    nations,
    generals,
    diplomacies,
    ...(world.commandMeta ? { commandMeta: world.commandMeta } : {}),
  } as unknown as WorldInit);
  return { ...state, ...(treaties ? { treaties } : {}) };
}
