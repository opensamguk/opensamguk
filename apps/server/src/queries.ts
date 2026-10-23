import type { Prisma, PrismaClient } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import { nowTick, TICKS_PER_MONTH, toGameDate } from '@opensamguk/rules';
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
  status: true,
  clockMode: true,
  endYear: true,
  result: true,
  startYear: true,
  clockTick: true,
  clockAnchorAt: true,
  turnTermMinutes: true,
} as const satisfies Prisma.WorldSelect;
type ReadWorld = Prisma.WorldGetPayload<{ select: typeof worldSelect }>;

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

export async function viewerGeneral(db: Prisma.TransactionClient, worldId: string, userId: string) {
  return db.general.findUnique({ where: { worldId_userId: { worldId, userId } } });
}
export async function requireGeneral(db: Prisma.TransactionClient, worldId: string, userId: string) {
  const general = await viewerGeneral(db, worldId, userId);
  if (!general) throw new TRPCError({ code: 'NOT_FOUND', message: '이 월드에 내 장수가 없습니다.' });
  return general;
}

export function worldSummary(world: ReadWorld, now: number) {
  const tick = nowTick({ ...world, clockAnchorAt: world.clockAnchorAt?.getTime() ?? null }, now);
  const row = world.status === 'ENDED' ? world.result : null;
  const result = row
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
  return {
    name: world.name,
    status: world.status,
    gameDate: result ? { year: result.year, month: result.month } : toGameDate(world.startYear, tick),
    clockMode: world.clockMode,
    endYear: world.endYear,
    result,
    nowTick: tick,
    msPerTick: (world.turnTermMinutes * 60_000) / TICKS_PER_MONTH,
    turnTermMinutes: world.turnTermMinutes,
  };
}

export function nextTurnAt(world: ReadWorld, tick: number): string | null {
  if (world.status !== 'RUNNING' || world.clockMode === 'ACCELERATED' || world.clockAnchorAt === null) return null;
  return new Date(
    world.clockAnchorAt.getTime() + ((tick - world.clockTick) * world.turnTermMinutes * 60_000) / TICKS_PER_MONTH,
  ).toISOString();
}

export function page<T extends { tick: number }>(rows: T[]) {
  const items = rows.slice(0, 30);
  return { items, nextCursor: rows.length > 30 ? String(items.at(-1)!.tick) : null };
}
export const beforeCursor = (cursor: string | undefined) =>
  cursor === undefined ? {} : { tick: { lt: Number(cursor) } };
