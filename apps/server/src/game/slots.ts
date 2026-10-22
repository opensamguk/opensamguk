import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import { commandRegistry, emptyTurns, type QueuedTurn } from '@opensamguk/rules';
import { z } from 'zod';
export const commandInput = { commandKey: z.string().min(1).max(64), args: z.unknown().optional() };
export const slotInput = z.strictObject(commandInput).nullable();
export function parseSlot(input: { commandKey: string; args?: unknown } | null): QueuedTurn {
  if (input === null) return { commandKey: 'rest', args: {} };
  const def = commandRegistry.get(input.commandKey);
  const args = def?.args.safeParse(input.args === undefined ? {} : input.args);
  if (!def || def.target !== 'general' || !args?.success)
    throw new TRPCError({ code: 'BAD_REQUEST', message: '명령과 인자를 확인하세요.' });
  return { commandKey: def.key, args: args.data };
}
export function displaySlots(turns: QueuedTurn[]) {
  return turns.map((turn) => ({ ...turn, name: commandRegistry.get(turn.commandKey)?.name ?? turn.commandKey }));
}
export async function readSlots(tx: Prisma.TransactionClient, worldId: string, generalId: number) {
  const rows = await tx.generalTurn.findMany({ where: { worldId, generalId } });
  const slots = emptyTurns();
  for (const row of rows)
    if (row.slot >= 0 && row.slot < 30) slots[row.slot] = { commandKey: row.commandKey, args: row.args };
  return slots;
}
