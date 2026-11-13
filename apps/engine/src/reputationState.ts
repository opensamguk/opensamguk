import { notifyActivityOnCommit } from '@opensamguk/db';
import type { Prisma } from '@opensamguk/db';
import {
  compareMonthlyReviews,
  compareReputationEvents,
  monthlyReviewSchema,
  readReputationLedger,
  reputationEventSchema,
  type ReputationEventRecord,
  type ReplayState,
} from '@opensamguk/rules';
import { z } from 'zod';

export async function loadReputationLedger(tx: Prisma.TransactionClient, worldId: string, startYear: number) {
  const events = await tx.reputationEvent.findMany({
    where: { worldId },
    orderBy: [{ year: 'asc' }, { month: 'asc' }, { generalId: 'asc' }, { kind: 'asc' }],
    select: {
      generalId: true,
      year: true,
      month: true,
      kind: true,
      score: true,
      tick: true,
      generalName: true,
      nationId: true,
      nationName: true,
      nationColor: true,
      cityKey: true,
      cityName: true,
    },
  });
  const reviews = await tx.monthlyReview.findMany({
    where: { worldId },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
    select: { year: true, month: true, tick: true, entries: true, headline: true },
  });
  return readReputationLedger(
    {
      events: events
        .map((row) => {
          if (
            (row.nationId === null && (row.nationName !== null || row.nationColor !== null)) ||
            (row.cityKey === null && row.cityName !== null)
          )
            throw Error('평판 사건의 공개 스냅샷이 다릅니다.');
          return reputationEventSchema.parse({
            generalId: row.generalId,
            year: row.year,
            month: row.month,
            kind: row.kind,
            score: row.score,
            tick: row.tick,
            data: {
              name: row.generalName,
              nation: row.nationId === null ? null : { id: row.nationId, name: row.nationName, color: row.nationColor },
              city: row.cityKey === null ? null : { cityKey: row.cityKey, name: row.cityName },
            },
          });
        })
        .sort(compareReputationEvents),
      reviews: reviews
        .map(({ year, month, tick, entries, headline }) =>
          monthlyReviewSchema.parse({ year, month, tick, entries, headline }),
        )
        .sort(compareMonthlyReviews),
    },
    startYear,
  );
}

export async function appendReputationEvents(
  tx: Prisma.TransactionClient,
  worldId: string,
  candidates: readonly ReputationEventRecord[],
) {
  if (!candidates.length) return;
  const data = candidates.map((candidate) => {
    const { data: snapshot, ...event } = reputationEventSchema.parse(candidate);
    return {
      worldId,
      ...event,
      generalName: snapshot.name,
      nationId: snapshot.nation?.id ?? null,
      nationName: snapshot.nation?.name ?? null,
      nationColor: snapshot.nation?.color ?? null,
      cityKey: snapshot.city?.cityKey ?? null,
      cityName: snapshot.city?.name ?? null,
    };
  });
  // 월드 잠금 안에서 처음 적용된 사건을 보존한다.
  const { count } = await tx.reputationEvent.createMany({ data, skipDuplicates: true });
  if (count > 0) await notifyActivityOnCommit(tx, worldId);
}

export async function persistMonthlyReview(
  tx: Prisma.TransactionClient,
  worldId: string,
  next: ReplayState,
  effects: unknown,
  tick: number,
) {
  const { review } = z.strictObject({ review: monthlyReviewSchema }).parse(effects);
  if (review.tick !== tick || JSON.stringify(next.reputation?.reviews.at(-1)) !== JSON.stringify(review))
    throw Error('저장할 월단평이 정산 원장과 다릅니다.');
  await tx.monthlyReview.create({ data: { worldId, ...review } });
}
