import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import { assertStorableJson } from '@opensamguk/db';
import {
  assertSlotSet,
  commandRegistry,
  extensionCommands,
  ruleRegistry,
  emptyQueue,
  emptyTurn,
  type PolicySlot,
  type QueuedTurn,
  type CommandResolver,
} from '@opensamguk/rules';
import { z } from 'zod';
import { worldResolver } from './resolver';
export const commandInput = { commandKey: z.string().min(1).max(64), args: z.unknown().optional() };
export const slotInput = z.strictObject(commandInput).nullable();
export function invalidSlot(): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message: '명령과 인자를 확인하세요.' });
}
export function parseSlot(input: { commandKey: string; args?: unknown } | null, allowExtensions = false): PolicySlot {
  if (input === null) return emptyTurn();
  const def =
    commandRegistry.get(input.commandKey) ??
    (allowExtensions
      ? [
          ...extensionCommands,
          ...ruleRegistry.features.flatMap(
            (feature) => feature.commandBindings?.map((binding) => binding.definition) ?? [],
          ),
        ].find((candidate) => candidate.key === input.commandKey)
      : undefined);
  const args = def?.args.safeParse(input.args === undefined ? {} : input.args);
  if (!def || def.target !== 'general' || !args?.success) invalidSlot();
  if (!commandRegistry.has(def.key)) {
    try {
      assertStorableJson(args.data, 'args');
    } catch {
      invalidSlot();
    }
  }
  return { commandKey: def.key, args: args.data, explicit: true };
}
export function hasExtensionSlot(turns: readonly QueuedTurn[]) {
  return turns.some((turn) => !commandRegistry.has(turn.commandKey));
}
export function assertEnabledSlots(world: Parameters<typeof worldResolver>[0], turns: readonly QueuedTurn[]) {
  if (!hasExtensionSlot(turns)) return;
  const { commands, resolver } = worldResolver(world);
  if (commands === null && turns.some((turn) => !resolver.get(turn.commandKey))) invalidSlot();
  if (turns.some((turn) => !resolver.get(turn.commandKey)))
    throw new TRPCError({ code: 'BAD_REQUEST', message: '이 월드에서 꺼진 명령입니다.' });
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
    (world.replayFormat === 3 ? world.ruleFeatures.includes('policy') : world.policyFromSequence !== null) ||
    (world.replayFormat !== 3 &&
      (await tx.inputEvent.findFirst({
        where: { worldId, kind: 'system.policy.enable', status: 'PENDING' },
        select: { id: true },
      })))
  )
    assertSlotSet(rows);
  const slots = emptyQueue();
  for (const row of rows)
    if (row.slot >= 0 && row.slot < 30)
      slots[row.slot] = { commandKey: row.commandKey, args: row.args, explicit: row.explicit };
  return slots;
}
