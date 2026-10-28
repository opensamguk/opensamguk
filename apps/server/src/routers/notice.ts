import type { Prisma } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { worldInput, entityKey } from '../queries';
import { bodyLimit, databaseTime, isLeader, messagingActor, writeMessaging } from '../messaging';
import type { Context } from '../context';

async function nationNotice(tx: Prisma.TransactionClient, ctx: Context, worldId: string) {
  const g = await messagingActor(tx, ctx, worldId);
  if (g.nationId === null) return null;
  const nation = await tx.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: g.nationId } } });
  const seen = z.object({ nationId: entityKey, revision: z.number().int().nonnegative() }).safeParse(g.noticeSeen);
  return {
    nationId: nation.id,
    revision: nation.noticeRevision,
    body: nation.notice,
    updatedAt: nation.noticeUpdatedAt?.toISOString() ?? null,
    updatedBy: nation.noticeUpdatedBy,
    unseen:
      nation.notice !== '' &&
      (!seen.success || seen.data.nationId !== nation.id || seen.data.revision < nation.noticeRevision),
    canEdit: isLeader(g),
  };
}
export const noticeRouter = router({
  nation: router({
    get: protectedProcedure
      .input(worldInput)
      .query(({ ctx, input }) =>
        ctx.db.$transaction((tx) => nationNotice(tx, ctx, input.worldId), { isolationLevel: 'RepeatableRead' }),
      ),
    set: worldVerifiedProcedure.input(worldInput.extend({ body: bodyLimit }).strict()).mutation(({ ctx, input }) =>
      writeMessaging(ctx, async (tx, notify) => {
        const g = await messagingActor(tx, ctx, input.worldId, true);
        if (!isLeader(g))
          throw new TRPCError({ code: 'FORBIDDEN', message: '군주와 참모만 국가 공지를 바꿀 수 있습니다.' });
        await tx.nation.update({
          where: { worldId_id: { worldId: input.worldId, id: g.nationId! } },
          data: {
            notice: input.body,
            noticeRevision: { increment: 1 },
            noticeUpdatedAt: await databaseTime(tx),
            noticeUpdatedBy: g.name,
          },
        });
        notify(input.worldId, { kind: 'notice.updated', scope: 'nation', target: { nationId: g.nationId! } });
        return nationNotice(tx, ctx, input.worldId);
      }),
    ),
    markSeen: worldVerifiedProcedure
      .input(worldInput.extend({ nationId: entityKey, revision: z.number().int().min(0).max(2147483647) }).strict())
      .mutation(({ ctx, input }) =>
        ctx.db.$transaction(async (tx) => {
          const g = await messagingActor(tx, ctx, input.worldId, true);
          if (g.nationId !== input.nationId) return nationNotice(tx, ctx, input.worldId);
          const nation = await tx.nation.findUniqueOrThrow({
            where: { worldId_id: { worldId: input.worldId, id: input.nationId } },
          });
          if (input.revision > nation.noticeRevision)
            throw new TRPCError({ code: 'BAD_REQUEST', message: '아직 없는 공지 판입니다.' });
          const seen = z.object({ nationId: entityKey, revision: z.number().int() }).safeParse(g.noticeSeen);
          if (!seen.success || seen.data.nationId !== input.nationId || seen.data.revision < input.revision)
            await tx.general.updateMany({
              where: { worldId: input.worldId, id: g.id, nationId: input.nationId },
              data: { noticeSeen: { nationId: input.nationId, revision: input.revision } },
            });
          return nationNotice(tx, ctx, input.worldId);
        }),
      ),
  }),
  world: router({
    list: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        await messagingActor(tx, ctx, input.worldId);
        const rows = await tx.notice.findMany({
          where: { scope: 'WORLD', worldId: input.worldId, hiddenAt: null },
          orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }],
          take: 20,
          select: { id: true, body: true, pinned: true, publishedAt: true },
        });
        return { items: rows.map((row) => ({ ...row, publishedAt: row.publishedAt.toISOString() })) };
      }),
    ),
  }),
});
