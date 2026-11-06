import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { readWorld, worldInput } from '../queries';
import { monthlyReviewSelect, readMonthlyReview } from '../review';

const getInput = worldInput
  .extend({ year: z.number().int().min(0).max(2_147_483_647), month: z.number().int().min(1).max(12) })
  .strict();
const orderBy = [{ year: 'desc' }, { month: 'desc' }] as const;

export const reviewRouter = router({
  latest: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      if (!world.ruleFeatures.includes('reputation-v1')) return null;
      const row = await tx.monthlyReview.findFirst({
        where: { worldId: input.worldId },
        orderBy: [...orderBy],
        select: monthlyReviewSelect,
      });
      if (!row) return null;
      const { year, month, entries } = readMonthlyReview(row, world.startYear);
      return { year, month, entries };
    }),
  ),
  get: protectedProcedure.input(getInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      if (!world.ruleFeatures.includes('reputation-v1')) return null;
      const row = await tx.monthlyReview.findUnique({
        where: { worldId_year_month: input },
        select: monthlyReviewSelect,
      });
      if (!row) return null;
      const { year, month, entries } = readMonthlyReview(row, world.startYear);
      return { year, month, entries };
    }),
  ),
  months: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      if (!world.ruleFeatures.includes('reputation-v1')) return [];
      const rows = await tx.monthlyReview.findMany({
        where: { worldId: input.worldId },
        orderBy: [...orderBy],
        take: 24,
        select: monthlyReviewSelect,
      });
      return rows.map((row) => {
        const { year, month } = readMonthlyReview(row, world.startYear);
        return { year, month };
      });
    }),
  ),
});
