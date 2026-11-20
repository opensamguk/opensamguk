import type { Prisma } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import { toGameDate } from '@opensamguk/rules';
import { z } from 'zod';

const watermark = z.object({
  publicNationEventId: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .max(20),
});
const nations = z.array(z.object({ id: z.number().int().positive(), name: z.string(), color: z.string() }));

export async function publicHeadlines(
  tx: Prisma.TransactionClient,
  input: { worldId: string; limit: number },
  now: number,
  delayMinutes: number,
) {
  const world = await tx.world.findUnique({ where: { id: input.worldId }, select: { startYear: true } });
  if (!world) throw new TRPCError({ code: 'NOT_FOUND' });
  const snapshot = await tx.publicMapSnapshot.findFirst({
    where: {
      worldId: input.worldId,
      OR: [
        { tick: 0, takenAt: { lte: new Date(now) }, data: { path: ['initial'], equals: true } },
        { takenAt: { lte: new Date(now - delayMinutes * 60_000) } },
      ],
    },
    orderBy: { takenAt: 'desc' },
    select: { data: true, takenAt: true },
  });
  const mark = watermark.safeParse(snapshot?.data);
  const rows = mark.success
    ? await tx.publicNationEvent.findMany({
        where: {
          worldId: input.worldId,
          id: { lte: BigInt(mark.data.publicNationEventId) },
          kind: { in: ['found', 'fall', 'declare', 'capture', 'unify', 'disaster', 'boom'] },
        },
        orderBy: [{ tick: 'desc' }, { id: 'desc' }],
        take: input.limit,
        select: { id: true, tick: true, kind: true, text: true, nations: true },
      })
    : [];
  return {
    worldId: input.worldId,
    delayMinutes,
    takenAt: snapshot?.takenAt.toISOString() ?? null,
    items: rows.map((row) => ({
      id: row.id.toString(),
      tick: row.tick,
      gameDate: toGameDate(world.startYear, row.tick),
      kind: row.kind,
      text: row.text,
      nations: nations.parse(row.nations),
    })),
  };
}
