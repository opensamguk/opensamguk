import { protectedProcedure, router } from '../trpc';
import { beforeCursor, page, readWorld, recordsInput, requireGeneral } from '../queries';
import { logInfo, logSelect, nationRecordInfo, worldRecordInfo } from '../visibility';
import { z } from 'zod';
import { decodeRecordCursor, encodeRecordCursor, generalLogCursor } from '../recordCursor';
import { worldInput } from '../queries';
import { monthlyReviewSelect, readMonthlyReview } from '../review';

const generalInput = worldInput.extend({ cursor: z.string().min(1).max(256).optional() }).strict();

export const recordsRouter = router({
  general: protectedProcedure.input(generalInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      // 기존 숫자 커서도 받고 새 응답은 같은 tick의 행까지 이어 읽는다.
      const legacy = recordsInput.shape.cursor.safeParse(input.cursor);
      const cursor =
        input.cursor === undefined || legacy.success ? null : decodeRecordCursor(input.cursor, generalLogCursor);
      const logs = await tx.generalLog.findMany({
        where: {
          worldId: input.worldId,
          generalId: general.id,
          ...(cursor
            ? { OR: [{ tick: { lt: cursor[0] } }, { tick: cursor[0], id: { lt: BigInt(cursor[1]) } }] }
            : beforeCursor(input.cursor)),
        },
        orderBy: [{ tick: 'desc' }, { id: 'desc' }],
        take: 31,
        select: logSelect,
      });
      const items = logs.slice(0, 30).map(logInfo);
      return {
        items,
        nextCursor: logs.length > 30 ? encodeRecordCursor([items.at(-1)!.tick, items.at(-1)!.id]) : null,
      };
    }),
  ),
  nation: protectedProcedure.input(recordsInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      if (general.nationId === null) return { items: [], nextCursor: null };
      const history = await tx.nationHistory.findMany({
        where: {
          worldId: input.worldId,
          nationId: general.nationId,
          // 사건 전용 JSON은 LIMIT 적용 전에 제외한다. 월간 요약의 nationId만 조회한다.
          data: { path: ['nationId'], equals: general.nationId },
          ...beforeCursor(input.cursor),
        },
        orderBy: { tick: 'desc' },
        take: 31,
        select: { tick: true, data: true },
      });
      return page(history.map((row) => ({ tick: row.tick, ...nationRecordInfo(row.data) })));
    }),
  ),
  world: protectedProcedure.input(recordsInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const history = await tx.yearbookSnapshot.findMany({
        where: { worldId: input.worldId, ...beforeCursor(input.cursor) },
        orderBy: { tick: 'desc' },
        take: 31,
        select: { tick: true, year: true, month: true, data: true },
      });
      const reviews =
        world.ruleFeatures.includes('reputation-v1') && history.length
          ? await tx.monthlyReview.findMany({
              where: { worldId: input.worldId, tick: { in: history.map((row) => row.tick) } },
              select: monthlyReviewSelect,
            })
          : [];
      const headlines = new Map(
        reviews.map((row) => {
          const review = readMonthlyReview(row, world.startYear);
          return [review.tick, review.headline];
        }),
      );
      return page(
        history.map((row) => ({
          tick: row.tick,
          year: row.year,
          month: row.month,
          ...worldRecordInfo(row.data),
          ...(headlines.get(row.tick) ? { review: { headline: headlines.get(row.tick)! } } : {}),
        })),
      );
    }),
  ),
});
