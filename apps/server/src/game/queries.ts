import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import { toWorldState, parsePreset, presetRules, type WorldInit } from '@opensamguk/rules';
import { z } from 'zod';
export const worldInput = z.strictObject({ worldId: z.string().min(1).max(64) });
export async function requireWorld(tx: Prisma.TransactionClient, worldId: string, lock = false) {
  if (lock) await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
  const world = await tx.world.findUnique({ where: { id: worldId }, omit: { replayOrigin: true } });
  if (!world) throw new TRPCError({ code: 'NOT_FOUND', message: '월드가 없습니다.' });
  return world;
}
export function requireRuleFeature(world: { ruleFeatures: readonly string[] }, key: string): void {
  if (!world.ruleFeatures.includes(key))
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '이 월드에서 켜지 않은 기능입니다.' });
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
  const cities = await tx.city.findMany({ where: { worldId } });
  const nations = await tx.nation.findMany({ where: { worldId } });
  const generals = await tx.general.findMany({ where: { worldId } });
  const diplomacies = await tx.diplomacy.findMany({ where: { worldId } });
  return toWorldState({
    ...(world.preset ? { presetRules: presetRules(parsePreset(world.preset)) } : {}),
    ...(world.ruleFeatures.length ? { ruleFeatures: [...world.ruleFeatures] } : {}),
    startYear: world.startYear,
    cities,
    nations,
    generals,
    diplomacies,
    ...(world.commandMeta ? { commandMeta: world.commandMeta } : {}),
  } as unknown as WorldInit);
}
