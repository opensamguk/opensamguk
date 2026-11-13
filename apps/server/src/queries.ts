import type { Prisma, PrismaClient } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import {
  nowTick,
  RELATIONS_FEATURE,
  TICKS_PER_MONTH,
  toGameDate,
  effectiveWorldOptions,
  parsePreset,
  timeAtTick,
  truceWindow,
  type Clock,
} from '@opensamguk/rules';
import { z } from 'zod';

export const worldInput = z.object({ worldId: z.uuid() }).strict();
export const entityKey = z.number().int().min(1).max(2_147_483_647);
export const recordsInput = worldInput
  .extend({
    cursor: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,9})$/)
      .refine((value) => Number(value) <= 2_147_483_647)
      .optional(),
  })
  .strict();
const worldSelect = {
  id: true,
  name: true,
  scenarioKey: true,
  status: true,
  clockMode: true,
  endYear: true,
  result: true,
  startYear: true,
  clockTick: true,
  clockAnchorAt: true,
  turnTermMinutes: true,
  ruleFeatures: true,
  preset: true,
  runtimeOptions: true,
} as const satisfies Prisma.WorldSelect;
type ReadWorld = Prisma.WorldGetPayload<{ select: typeof worldSelect }>;
export type ClockWorld = Pick<
  ReadWorld,
  'status' | 'clockMode' | 'clockTick' | 'clockAnchorAt' | 'turnTermMinutes' | 'preset' | 'runtimeOptions'
>;
export function worldClock(world: ClockWorld): Clock {
  return {
    status: world.status,
    clockMode: world.clockMode,
    clockTick: world.clockTick,
    clockAnchorAt: world.clockAnchorAt?.getTime() ?? null,
    turnTermMinutes: world.turnTermMinutes,
    truce: effectiveWorldOptions(world.preset === null ? null : parsePreset(world.preset), world.runtimeOptions).truce,
  };
}
function truceStatus(clock: Clock, now: number) {
  if (clock.truce == null) return null;
  const window = truceWindow(now, clock.truce);
  return {
    ...clock.truce,
    active: window.active,
    endsAt: window.endsAt === null ? null : new Date(window.endsAt).toISOString(),
    nextStartsAt: new Date(window.nextStartsAt).toISOString(),
    nextEndsAt: new Date(window.nextEndsAt).toISOString(),
  };
}

export async function readWorld<T>(
  db: PrismaClient,
  worldId: string,
  read: (tx: Prisma.TransactionClient, world: ReadWorld) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      const world = await tx.world.findUnique({ where: { id: worldId }, select: worldSelect });
      if (!world) throw new TRPCError({ code: 'NOT_FOUND', message: '월드를 찾을 수 없습니다.' });
      return read(tx, world);
    },
    { isolationLevel: 'RepeatableRead' },
  );
}

export function countHumanGenerals(tx: Prisma.TransactionClient, worldId: string) {
  return tx.general.count({ where: { worldId, userId: { not: null }, removedAt: null } });
}

export async function viewerGeneral(db: Prisma.TransactionClient, worldId: string, userId: string) {
  return db.general.findUnique({ where: { worldId_userId: { worldId, userId } } });
}
export async function requireGeneral(db: Prisma.TransactionClient, worldId: string, userId: string) {
  const general = await viewerGeneral(db, worldId, userId);
  if (!general) throw new TRPCError({ code: 'NOT_FOUND', message: '이 월드에 내 장수가 없습니다.' });
  return general;
}

export function seasonResultInfo(world: Pick<ReadWorld, 'status' | 'result'>) {
  const row = world.status === 'ENDED' ? world.result : null;
  return row
    ? {
        reason: row.reason,
        year: row.endedYear,
        month: row.endedMonth,
        winner:
          row.winnerNationId === null
            ? null
            : { nationId: row.winnerNationId, name: row.winnerName!, color: row.winnerColor! },
        remainingNations: row.remainingNations,
        endedAt: row.endedAt.toISOString(),
      }
    : null;
}

export function worldSummary(world: Omit<ReadWorld, 'scenarioKey'>, now: number) {
  const clock = worldClock(world);
  const tick = nowTick(clock, now);
  const result = seasonResultInfo(world);
  return {
    name: world.name,
    status: world.status,
    startYear: world.startYear,
    gameDate: result ? { year: result.year, month: result.month } : toGameDate(world.startYear, tick),
    clockMode: world.clockMode,
    endYear: world.endYear,
    result,
    nowTick: tick,
    msPerTick: (world.turnTermMinutes * 60_000) / TICKS_PER_MONTH,
    turnTermMinutes: world.turnTermMinutes,
    truce: truceStatus(clock, now),
    ...(world.ruleFeatures.includes('city-resources-v1') ? { cityResourcesEnabled: true as const } : {}),
    ...(world.ruleFeatures.includes('logistics-v1') ? { logisticsEnabled: true as const } : {}),
    ...(world.ruleFeatures.includes('governance-v1') ? { governanceEnabled: true as const } : {}),
    ...(world.ruleFeatures.includes('lineage-v1') ? { lineageEnabled: true as const } : {}),
    ...(world.ruleFeatures.includes(RELATIONS_FEATURE) ? { relationsEnabled: true as const } : {}),
    ...(world.ruleFeatures.includes('equipment-v1') ? { equipmentEnabled: true as const } : {}),
  };
}

function scheduledAt(clock: Clock, tick: number): string | null {
  try {
    return new Date(timeAtTick(clock, tick)).toISOString();
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
export function nextTurnAt(world: ClockWorld, tick: number): string | null {
  if (world.status !== 'RUNNING' || world.clockMode === 'ACCELERATED' || world.clockAnchorAt === null) return null;
  return scheduledAt(worldClock(world), tick);
}
export function turnSchedule(world: ClockWorld, tick: number): Array<string | null> | null {
  if (world.status !== 'RUNNING' || world.clockMode === 'ACCELERATED' || world.clockAnchorAt === null) return null;
  const clock = worldClock(world);
  return Array.from({ length: 30 }, (_, slot) => scheduledAt(clock, tick + slot * TICKS_PER_MONTH));
}

export function page<T extends { tick: number }>(rows: T[]) {
  const items = rows.slice(0, 30);
  return { items, nextCursor: rows.length > 30 ? String(items.at(-1)!.tick) : null };
}
export const beforeCursor = (cursor: string | undefined) =>
  cursor === undefined ? {} : { tick: { lt: Number(cursor) } };
