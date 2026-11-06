import { toGameDate } from '../clock/clock';
import {
  monthlyReviewSchema,
  reputationEventSchema,
  reputationLedgerSchema,
  type ReputationEventRecord,
  type ReputationLedger,
  type MonthlyReviewRecord,
} from './schema';

export function compareReputationEvents(a: ReputationEventRecord, b: ReputationEventRecord) {
  return (
    a.year - b.year ||
    a.month - b.month ||
    a.generalId - b.generalId ||
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
  );
}
export function compareMonthlyReviews(a: MonthlyReviewRecord, b: MonthlyReviewRecord) {
  return a.year - b.year || a.month - b.month;
}
export function readReputationLedger(value: unknown, startYear: number): ReputationLedger {
  const ledger = reputationLedgerSchema.parse(value);
  for (const [index, event] of ledger.events.entries()) {
    const date = toGameDate(startYear, event.tick);
    if (
      date.year !== event.year ||
      date.month !== event.month ||
      (index > 0 && compareReputationEvents(ledger.events[index - 1]!, event) >= 0)
    )
      throw Error('평판 사건의 날짜나 순서가 다릅니다.');
  }
  for (const [index, review] of ledger.reviews.entries()) {
    const date = toGameDate(startYear, review.tick - 1);
    if (
      date.year !== review.year ||
      date.month !== review.month ||
      (index > 0 && compareMonthlyReviews(ledger.reviews[index - 1]!, review) >= 0)
    )
      throw Error('월단평의 날짜나 순서가 다릅니다.');
  }
  return ledger;
}
export function appendReputationEvents(
  ledger: ReputationLedger,
  candidates: readonly ReputationEventRecord[],
): ReputationLedger {
  let events = ledger.events;
  for (const raw of candidates) {
    const candidate = reputationEventSchema.parse(raw);
    let low = 0,
      high = events.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (compareReputationEvents(events[middle]!, candidate) < 0) low = middle + 1;
      else high = middle;
    }
    if (events[low] && compareReputationEvents(events[low]!, candidate) === 0) continue;
    events = [...events.slice(0, low), candidate, ...events.slice(low)];
  }
  return events === ledger.events ? ledger : { ...ledger, events };
}
export function appendMonthlyReview(ledger: ReputationLedger, value: MonthlyReviewRecord): ReputationLedger {
  const review = monthlyReviewSchema.parse(value);
  if (ledger.reviews.some((row) => compareMonthlyReviews(row, review) === 0))
    throw Error('같은 달의 월단평이 이미 있습니다.');
  return { ...ledger, reviews: [...ledger.reviews, review].sort(compareMonthlyReviews) };
}
