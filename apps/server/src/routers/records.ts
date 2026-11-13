import { TRPCError } from '@trpc/server';
import { rankGenerals, reputationEventSchema } from '@opensamguk/rules';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { beforeCursor, page, readWorld, recordsInput, requireGeneral, seasonResultInfo, worldInput } from '../queries';
import { logInfo, logSelect, nationRecordInfo, worldRecordInfo } from '../visibility';
import { z } from 'zod';
import { decodeRecordCursor, encodeRecordCursor, generalLogCursor } from '../recordCursor';
import { monthlyReviewSelect, readMonthlyReview } from '../review';

const generalInput = worldInput.extend({ cursor: z.string().min(1).max(256).optional() }).strict();

const seasonInput = worldInput.extend({ by: z.enum(['dedication', 'experience', 'merit']).default('dedication') });

export const recordsRouter = router({
  activity: protectedProcedure.input(generalInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const cursor = input.cursor === undefined ? null : decodeRecordCursor(input.cursor, generalLogCursor);
      const rows = await tx.reputationEvent.findMany({
        where: {
          worldId: input.worldId,
          ...(cursor ? { OR: [{ tick: { lt: cursor[0] } }, { tick: cursor[0], id: { lt: BigInt(cursor[1]) } }] } : {}),
        },
        orderBy: [{ tick: 'desc' }, { id: 'desc' }],
        take: 31,
        select: {
          id: true,
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
      const items = rows.slice(0, 30).map((row) => {
        const { id, generalName, nationId, nationName, nationColor, cityKey, cityName, ...event } = row;
        return {
          id: id.toString(),
          ...reputationEventSchema.parse({
            ...event,
            data: {
              name: generalName,
              nation: nationId === null ? null : { id: nationId, name: nationName, color: nationColor },
              city: cityKey === null ? null : { cityKey, name: cityName },
            },
          }),
        };
      });
      return {
        items,
        nextCursor: rows.length > 30 ? encodeRecordCursor([items.at(-1)!.tick, items.at(-1)!.id]) : null,
      };
    }),
  ),
  season: worldVerifiedProcedure.input(seasonInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const result = seasonResultInfo(world);
      if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: '기수 결과가 없습니다.' });
      const rows = await tx.seasonGeneral.findMany({
        where: { worldId: input.worldId },
        select: {
          generalId: true,
          name: true,
          nationId: true,
          nationName: true,
          nationColor: true,
          dedication: true,
          experience: true,
          wins: true,
          captures: true,
        },
      });
      const generals = rankGenerals(
        rows.map(({ generalId, nationId, nationName, nationColor, ...row }) => ({
          ...row,
          id: generalId,
          nation: nationId === null ? null : { id: nationId, name: nationName!, color: nationColor! },
        })),
        input.by,
      ).map(({ id, ...row }) => ({ generalId: id, ...row }));
      return { result, generals };
    }),
  ),
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
