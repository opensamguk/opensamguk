import { z } from 'zod';
import { REPUTATION_POINTS } from '../balance';
import { TICKS_PER_MONTH } from '../clock/constants';
import { reputationHeadline } from './lines';

export const REPUTATION_FEATURE = 'reputation-v1';
export const REPUTATION_KINDS = ['conquest', 'victory', 'domestic', 'betrayal', 'defeat'] as const;
export type ReputationKind = (typeof REPUTATION_KINDS)[number];
const id = z.number().int().min(1).max(2_147_483_647);
const year = z.number().int().nonnegative();
const month = z.number().int().min(1).max(12);
const tick = z.number().int().min(0).max(2_147_483_647);
const name = z.string().min(1);
const kind = z.enum(REPUTATION_KINDS);
const nation = z.strictObject({ id, name, color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).nullable();
const snapshot = z.strictObject({ name, nation, city: z.strictObject({ cityKey: id, name }).nullable() });

export const reputationEventSchema = z
  .strictObject({
    generalId: id,
    year,
    month,
    kind,
    score: z.number().int(),
    tick,
    data: snapshot,
  })
  .superRefine((event, ctx) => {
    if (event.score !== REPUTATION_POINTS[event.kind])
      ctx.addIssue({ code: 'custom', message: '평판 사건의 점수가 다릅니다.' });
    const publicBattle = ['conquest', 'victory', 'defeat'].includes(event.kind);
    if (publicBattle !== (event.data.city !== null))
      ctx.addIssue({ code: 'custom', message: '평판 사건의 공개 도시가 다릅니다.' });
  });
export type ReputationEventRecord = z.infer<typeof reputationEventSchema>;

export const monthlyReviewEntrySchema = z
  .strictObject({
    rank: z.number().int().min(1).max(5),
    generalId: id,
    name,
    nation,
    score: z.number().int().positive(),
    kinds: z.array(kind).min(1).max(5),
    line: z.string().min(1),
  })
  .superRefine((entry, ctx) => {
    if (
      entry.kinds.some(
        (key, index) => index > 0 && REPUTATION_KINDS.indexOf(key) <= REPUTATION_KINDS.indexOf(entry.kinds[index - 1]!),
      )
    )
      ctx.addIssue({ code: 'custom', message: '평판 사건 종류가 중복되거나 순서가 다릅니다.' });
    if (entry.score !== entry.kinds.reduce((sum, key) => sum + REPUTATION_POINTS[key], 0))
      ctx.addIssue({ code: 'custom', message: '월단평 합계가 사건 점수와 다릅니다.' });
  });
export type MonthlyReviewEntry = z.infer<typeof monthlyReviewEntrySchema>;

export function compareReviewEntries(
  a: Pick<MonthlyReviewEntry, 'score' | 'kinds' | 'generalId'>,
  b: Pick<MonthlyReviewEntry, 'score' | 'kinds' | 'generalId'>,
) {
  const positive = (keys: readonly ReputationKind[]) => keys.filter((key) => REPUTATION_POINTS[key] > 0).length;
  return b.score - a.score || positive(b.kinds) - positive(a.kinds) || a.generalId - b.generalId;
}

export const monthlyReviewSchema = z
  .strictObject({
    year,
    month,
    tick: tick.positive().multipleOf(TICKS_PER_MONTH),
    entries: z.array(monthlyReviewEntrySchema).max(5),
    headline: z.string().min(1).nullable(),
  })
  .superRefine((review, ctx) => {
    const ids = new Set<number>();
    for (const [index, entry] of review.entries.entries()) {
      if (
        entry.rank !== index + 1 ||
        ids.has(entry.generalId) ||
        (index > 0 && compareReviewEntries(review.entries[index - 1]!, entry) >= 0)
      )
        ctx.addIssue({ code: 'custom', message: '월단평 순위가 다릅니다.' });
      ids.add(entry.generalId);
    }
    if (review.headline !== reputationHeadline(review.year, review.month, review.entries))
      ctx.addIssue({ code: 'custom', message: '월단평 제목이 순위와 다릅니다.' });
  });
export type MonthlyReviewRecord = z.infer<typeof monthlyReviewSchema>;
export const reputationLedgerSchema = z.strictObject({
  events: z.array(reputationEventSchema),
  reviews: z.array(monthlyReviewSchema),
});
export type ReputationLedger = z.infer<typeof reputationLedgerSchema>;
