import type { Prisma } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import { rankGenerals, reputationEventSchema, toGameDate } from '@opensamguk/rules';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import {
  beforeCursor,
  entityKey,
  page,
  readWorld,
  recordsInput,
  requireGeneral,
  seasonResultInfo,
  worldInput,
} from '../queries';
import { logInfo, logSelect, nationRecordInfo, worldRecordInfo } from '../visibility';
import { z } from 'zod';
import { decodeRecordCursor, encodeRecordCursor, generalLogCursor, recordId, recordTick } from '../recordCursor';
import { monthlyReviewSelect, readMonthlyReview } from '../review';

const generalInput = worldInput.extend({ cursor: z.string().min(1).max(256).optional() }).strict();
const activityInput = generalInput.extend({ scope: z.enum(['all', 'world']).default('all') });
const activityCursor = z.tuple([recordTick, z.enum(['reputation', 'nation']), recordId]);
const nationEventKind = z.enum(['found', 'fall', 'declare', 'capture']);
const battleCursor = z.tuple([recordTick, entityKey]);

async function recordPortraits(tx: Prisma.TransactionClient, worldId: string, ids: number[]) {
  if (!ids.length) return new Map<number, number | null>();
  const generals = await tx.general.findMany({
    where: { worldId, id: { in: ids } },
    select: { id: true, portraitId: true },
  });
  return new Map(generals.map(({ id, portraitId }) => [id, portraitId]));
}

const seasonInput = worldInput.extend({ by: z.enum(['dedication', 'experience', 'merit']).default('dedication') });

export const recordsRouter = router({
  battles: protectedProcedure.input(generalInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      const cursor = input.cursor === undefined ? null : decodeRecordCursor(input.cursor, battleCursor);
      const rows = await tx.battleLog.findMany({
        where: {
          worldId: input.worldId,
          generalId: general.id,
          ...(cursor ? { OR: [{ tick: { lt: cursor[0] } }, { tick: cursor[0], attackerId: { lt: cursor[1] } }] } : {}),
        },
        orderBy: [{ tick: 'desc' }, { attackerId: 'desc' }],
        take: 31,
        select: { tick: true, attackerId: true, text: true },
      });
      const page = rows.slice(0, 30);
      const portraits = await recordPortraits(
        tx,
        input.worldId,
        page.map(({ attackerId }) => attackerId),
      );
      const items = page.map((row) => ({
        tick: row.tick,
        attackerId: row.attackerId,
        portraitId: portraits.get(row.attackerId) ?? null,
        text: row.text,
        gameDate: toGameDate(world.startYear, row.tick),
      }));
      const last = items.at(-1);
      return { items, nextCursor: rows.length > 30 && last ? encodeRecordCursor([last.tick, last.attackerId]) : null };
    }),
  ),
  activity: protectedProcedure.input(activityInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const cursor = input.cursor === undefined ? null : decodeRecordCursor(input.cursor, activityCursor);
      const before = (source: 'reputation' | 'nation') => {
        if (!cursor) return {};
        const [tick, cursorSource, id] = cursor;
        if (source !== cursorSource) return { tick: source === 'nation' ? { lte: tick } : { lt: tick } };
        return { OR: [{ tick: { lt: tick } }, { tick, id: { lt: BigInt(id) } }] };
      };
      const rows =
        input.scope === 'world'
          ? []
          : await tx.reputationEvent.findMany({
              where: {
                worldId: input.worldId,
                ...before('reputation'),
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
      const news = await tx.publicNationEvent.findMany({
        where: { worldId: input.worldId, ...before('nation') },
        orderBy: [{ tick: 'desc' }, { id: 'desc' }],
        take: 31,
        select: { id: true, tick: true, kind: true, text: true },
      });
      const reputation = rows.map((row) => {
        const { id, generalName, nationId, nationName, nationColor, cityKey, cityName, ...event } = row;
        return {
          id: id.toString(),
          source: 'reputation' as const,
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
      const nation = news.map(({ id, tick, kind, text }) => ({
        source: 'nation' as const,
        id: id.toString(),
        tick,
        ...toGameDate(world.startYear, tick),
        kind: nationEventKind.parse(kind),
        text,
      }));
      // 각 원장은 이미 같은 tick에서 id 내림차순이다. 같은 tick은 평판 원장을 먼저 읽는다.
      const sorted = [...reputation, ...nation].sort((a, b) => b.tick - a.tick);
      const page = sorted.slice(0, 30);
      const portraits = await recordPortraits(
        tx,
        input.worldId,
        page.flatMap((item) => (item.source === 'reputation' ? [item.generalId] : [])),
      );
      const items = page.map((item) => ({
        ...item,
        portraitId: item.source === 'reputation' ? (portraits.get(item.generalId) ?? null) : null,
      }));
      const last = items.at(-1);
      return {
        items,
        nextCursor: sorted.length > 30 && last ? encodeRecordCursor([last.tick, last.source, last.id]) : null,
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
          officerLevel: true,
          dedication: true,
          experience: true,
          wins: true,
          captures: true,
        },
      });
      const officerLevels = new Map(rows.map(({ generalId, officerLevel }) => [generalId, officerLevel]));
      const generals = rankGenerals(
        rows.map(({ generalId, name, nationId, nationName, nationColor, dedication, experience, wins, captures }) => ({
          id: generalId,
          name,
          dedication,
          experience,
          wins,
          captures,
          nation: nationId === null ? null : { id: nationId, name: nationName!, color: nationColor! },
        })),
        input.by,
      ).map(({ id, ...row }) => ({ generalId: id, ...row, officerLevel: officerLevels.get(id)! }));
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
