import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { activeSanctionWhere } from '../auth/sanction';

export const sanctionRouter = router({
  mine: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const sanctions = await ctx.db.sanction.findMany({
      where: { userId: ctx.user.id, worldId: { not: null }, ...activeSanctionWhere(ctx.now) },
      select: { worldId: true, world: { select: { name: true } }, reason: true, expiresAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return sanctions.map(({ worldId, world, reason, expiresAt }) => ({
      worldId: worldId!,
      worldName: world!.name,
      reason,
      expiresAt: expiresAt?.toISOString() ?? null,
    }));
  }),
});
