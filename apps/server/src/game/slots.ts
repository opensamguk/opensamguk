import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import {
  assertSlotSet,
  commandRegistry,
  emptyQueue,
  emptyTurn,
  type PolicySlot,
  type QueuedTurn,
  type CommandResolver,
} from '@opensamguk/rules';
import { z } from 'zod';
export const commandInput = { commandKey: z.string().min(1).max(64), args: z.unknown().optional() };
export const slotInput = z.strictObject(commandInput).nullable();
export function parseSlot(input: { commandKey: string; args?: unknown } | null): PolicySlot {
  if (input === null) return emptyTurn();
  const def = commandRegistry.get(input.commandKey);
  const args = def?.args.safeParse(input.args === undefined ? {} : input.args);
  if (!def || def.target !== 'general' || !args?.success)
    throw new TRPCError({ code: 'BAD_REQUEST', message: '명령과 인자를 확인하세요.' });
  return { commandKey: def.key, args: args.data, explicit: true };
}
export function displaySlots(turns: QueuedTurn[], resolver?: CommandResolver) {
  return turns.map((turn) => ({
    ...turn,
    explicit: turn.explicit ?? true,
    name: (resolver ? resolver.get(turn.commandKey) : commandRegistry.get(turn.commandKey))?.name ?? turn.commandKey,
  }));
}
export async function readSlots(tx: Prisma.TransactionClient, worldId: string, generalId: number) {
  const rows = await tx.generalTurn.findMany({ where: { worldId, generalId } });
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  if (
    world.policyFromSequence !== null ||
    (await tx.inputEvent.findFirst({
      where: { worldId, kind: 'system.policy.enable', status: 'PENDING' },
      select: { id: true },
    }))
  )
    assertSlotSet(rows);
  const slots = emptyQueue();
  for (const row of rows)
    if (row.slot >= 0 && row.slot < 30)
      slots[row.slot] = { commandKey: row.commandKey, args: row.args, explicit: row.explicit };
  return slots;
}
