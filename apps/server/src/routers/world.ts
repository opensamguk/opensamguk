import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

export const worldRouter = router({
  list: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const worlds = await ctx.db.world.findMany({
      where: { status: 'RUNNING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, status: true },
    });
    return { worlds };
  }),
});
