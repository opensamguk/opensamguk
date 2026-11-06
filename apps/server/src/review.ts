import type { Prisma } from '@opensamguk/db';
import { readReputationLedger } from '@opensamguk/rules';

export const monthlyReviewSelect = {
  year: true,
  month: true,
  tick: true,
  entries: true,
  headline: true,
} as const satisfies Prisma.MonthlyReviewSelect;

export function readMonthlyReview(
  row: Prisma.MonthlyReviewGetPayload<{ select: typeof monthlyReviewSelect }>,
  startYear: number,
) {
  return readReputationLedger({ events: [], reviews: [row] }, startYear).reviews[0]!;
}
