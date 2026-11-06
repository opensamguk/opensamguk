import type { Rng } from '@opensamguk/shared';
import {
  compareReviewEntries,
  monthlyReviewSchema,
  REPUTATION_KINDS,
  type MonthlyReviewRecord,
  type ReputationEventRecord,
} from './schema';
import { reputationHeadline, reputationLine } from './lines';

export function buildMonthlyReview(
  events: readonly ReputationEventRecord[],
  date: { year: number; month: number; tick: number },
  rng: Rng,
): MonthlyReviewRecord {
  const groups = new Map<number, ReputationEventRecord[]>();
  for (const event of events) {
    if (event.year !== date.year || event.month !== date.month) continue;
    const group = groups.get(event.generalId) ?? [];
    if (group.some((row) => row.kind === event.kind)) throw Error('같은 달의 평판 사건이 중복됐습니다.');
    group.push(event);
    groups.set(event.generalId, group);
  }
  const candidates = [...groups.entries()]
    .map(([generalId, group]) => {
      const last = [...group]
        .sort((a, b) => a.tick - b.tick || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
        .at(-1)!;
      const representative = [...group].sort(
        (a, b) =>
          Math.abs(b.score) - Math.abs(a.score) || REPUTATION_KINDS.indexOf(a.kind) - REPUTATION_KINDS.indexOf(b.kind),
      )[0]!;
      return {
        generalId,
        name: last.data.name,
        nation: last.data.nation,
        score: group.reduce((sum, row) => sum + row.score, 0),
        kinds: REPUTATION_KINDS.filter((key) => group.some((row) => row.kind === key)),
        representative,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort(compareReviewEntries)
    .slice(0, 5);
  const entries = candidates.map(({ representative, ...entry }, index) => ({
    ...entry,
    rank: index + 1,
    line: reputationLine(representative.kind, { name: entry.name, city: representative.data.city?.name ?? null }, rng),
  }));
  return monthlyReviewSchema.parse({ ...date, entries, headline: reputationHeadline(date.year, date.month, entries) });
}
