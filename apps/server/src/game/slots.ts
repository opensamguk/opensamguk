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
export function parseSlot(
  input: { commandKey: string; args?: unknown } | null,
  allowExtensions = false,
  resolver?: CommandResolver,
): PolicySlot {
  if (input === null) return emptyTurn();
  const def =
    resolver?.get(input.commandKey) ??
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
export function hasExtensionSlot(turns: readonly Pick<QueuedTurn, 'commandKey'>[]) {
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
export async function displaySlotTargets(
  tx: Prisma.TransactionClient,
  worldId: string,
  slots: ReturnType<typeof displaySlots>,
  visibility: { fogEnabled: boolean; nationId: number | null },
) {
  const references = slots.map(({ args }) => {
    if (!args || typeof args !== 'object') return {};
    const { cityKey, nationId, generalId } = args as Record<string, unknown>;
    return {
      ...(typeof cityKey === 'number' && Number.isInteger(cityKey) && cityKey > 0 && cityKey <= 2_147_483_647
        ? { cityKey }
        : {}),
      ...(typeof nationId === 'number' && Number.isInteger(nationId) && nationId > 0 && nationId <= 2_147_483_647
        ? { nationId }
        : {}),
      ...(typeof generalId === 'number' && Number.isInteger(generalId) && generalId > 0 && generalId <= 2_147_483_647
        ? { generalId }
        : {}),
    };
  });
  const cityKeys = references.flatMap(({ cityKey }) => (cityKey === undefined ? [] : [cityKey]));
  const nationIds = references.flatMap(({ nationId }) => (nationId === undefined ? [] : [nationId]));
  const generalIds = references.flatMap(({ generalId }) => (generalId === undefined ? [] : [generalId]));
  const [cities, nations, generals] = await Promise.all([
    cityKeys.length
      ? tx.city.findMany({
          where: { worldId, cityKey: { in: cityKeys } },
          select: { cityKey: true, name: true },
        })
      : [],
    nationIds.length
      ? tx.nation.findMany({
          where: { worldId, id: { in: nationIds } },
          select: { id: true, name: true },
        })
      : [],
    generalIds.length
      ? tx.general.findMany({
          where: {
            worldId,
            id: { in: generalIds },
            removedAt: null,
            ...(visibility.fogEnabled ? { city: { OR: [{ nationId: null }, { nationId: visibility.nationId }] } } : {}),
          },
          select: { id: true, name: true },
        })
      : [],
  ]);
  const cityNames = new Map(cities.map(({ cityKey, name }) => [cityKey, name]));
  const nationNames = new Map(nations.map(({ id, name }) => [id, name]));
  const generalNames = new Map(generals.map(({ id, name }) => [id, name]));
  return slots.map((slot, index) => {
    const { cityKey, nationId, generalId } = references[index]!;
    const targets = {
      ...(cityKey === undefined ? {} : { city: cityNames.get(cityKey) ?? null }),
      ...(nationId === undefined ? {} : { nation: nationNames.get(nationId) ?? null }),
      ...(generalId === undefined ? {} : { general: generalNames.get(generalId) ?? null }),
    };
    return Object.keys(targets).length ? { ...slot, targets } : slot;
  });
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
