import type { Prisma } from '@opensamguk/db';
import { canUseNationTurns, nowTick, NATION_RESTRICTIONS_FEATURE, storedNationRestrictions } from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Context } from '../context';
import { messageBody, messagingActor } from '../messaging';
import { nationTenureYears } from '../game/nationTenure';
import { entityKey, worldClock, worldInput } from '../queries';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';

const boardInput = worldInput.extend({ nationId: entityKey, confidential: z.boolean() });
const authorSelect = { id: true, authorName: true, portraitId: true, body: true, sentAt: true } as const;
const newest = [{ sentAt: 'desc' }, { id: 'desc' }] as const;

async function boardActor(tx: Prisma.TransactionClient, ctx: Context, input: z.infer<typeof boardInput>, lock = false) {
  const actor = await messagingActor(tx, ctx, input.worldId, lock);
  if (actor.nationId !== input.nationId || actor.removedAt !== null)
    throw new TRPCError({ code: 'FORBIDDEN', message: '이 게시판을 이용할 권한이 없습니다.' });
  let canReadConfidential = canUseNationTurns(actor.officerLevel);
  const world =
    lock || (!canReadConfidential && actor.officerLevel > 0)
      ? await tx.world.findUniqueOrThrow({
          where: { id: input.worldId },
          select: {
            status: true,
            ruleFeatures: true,
            clockMode: true,
            clockTick: true,
            clockAnchorAt: true,
            turnTermMinutes: true,
            preset: true,
            runtimeOptions: true,
          },
        })
      : null;
  if (lock && world?.status === 'ENDED')
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '종료된 월드입니다.' });
  if (!canReadConfidential && actor.officerLevel > 0 && world?.ruleFeatures.includes(NATION_RESTRICTIONS_FEATURE)) {
    const nation = await tx.nation.findUniqueOrThrow({
      where: { worldId_id: { worldId: input.worldId, id: actor.nationId } },
      select: { restrictions: true },
    });
    const years = storedNationRestrictions(true, nation.restrictions).restrictions?.confidentialYears;
    if (years !== undefined) {
      const tick = nowTick(worldClock(world), ctx.now);
      canReadConfidential = (nationTenureYears(actor.nationJoinedTick, tick) ?? 0) >= years;
    }
  }
  if (input.confidential && !canReadConfidential)
    throw new TRPCError({ code: 'FORBIDDEN', message: '이 게시판을 이용할 권한이 없습니다.' });
  return { nationId: actor.nationId, name: actor.name, portraitId: actor.portraitId, canReadConfidential };
}

export const nationBoardRouter = router({
  list: protectedProcedure.input(boardInput.extend({ cursor: z.uuid().optional() }).strict()).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        const actor = await boardActor(tx, ctx, input);
        const where = { worldId: input.worldId, nationId: actor.nationId, confidential: input.confidential };
        const after = input.cursor
          ? await tx.nationBoardPost.findFirst({
              where: { ...where, id: input.cursor },
              select: { id: true, sentAt: true },
            })
          : null;
        if (input.cursor && !after) throw new TRPCError({ code: 'NOT_FOUND', message: '게시물을 찾을 수 없습니다.' });
        const posts = await tx.nationBoardPost.findMany({
          where: {
            ...where,
            ...(after
              ? { OR: [{ sentAt: { lt: after.sentAt } }, { sentAt: after.sentAt, id: { lt: after.id } }] }
              : {}),
          },
          orderBy: [...newest],
          take: 21,
          select: {
            ...authorSelect,
            title: true,
            _count: { select: { replies: true } },
            replies: { orderBy: [...newest], take: 20, select: authorSelect },
          },
        });
        const page = posts.slice(0, 20);
        return {
          canReadConfidential: actor.canReadConfidential,
          items: page.map(({ _count, replies, sentAt, ...post }) => ({
            ...post,
            sentAt: sentAt.toISOString(),
            replyCount: _count.replies,
            replies: replies.reverse().map((reply) => ({ ...reply, sentAt: reply.sentAt.toISOString() })),
          })),
          next: posts.length > page.length ? page.at(-1)!.id : null,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  ),
  replies: protectedProcedure
    .input(boardInput.extend({ postId: z.uuid(), cursor: z.uuid() }).strict())
    .query(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) => {
          const actor = await boardActor(tx, ctx, input);
          const after = await tx.nationBoardReply.findFirst({
            where: {
              id: input.cursor,
              postId: input.postId,
              post: { worldId: input.worldId, nationId: actor.nationId, confidential: input.confidential },
            },
            select: { id: true, sentAt: true },
          });
          if (!after) throw new TRPCError({ code: 'NOT_FOUND', message: '댓글을 찾을 수 없습니다.' });
          const replies = await tx.nationBoardReply.findMany({
            where: {
              postId: input.postId,
              OR: [{ sentAt: { lt: after.sentAt } }, { sentAt: after.sentAt, id: { lt: after.id } }],
            },
            orderBy: [...newest],
            take: 21,
            select: authorSelect,
          });
          const page = replies.slice(0, 20);
          return {
            next: replies.length > page.length ? page.at(-1)!.id : null,
            items: page.reverse().map((reply) => ({ ...reply, sentAt: reply.sentAt.toISOString() })),
          };
        },
        { isolationLevel: 'RepeatableRead' },
      ),
    ),
  write: worldVerifiedProcedure
    .input(
      boardInput
        .extend({
          content: z.discriminatedUnion('type', [
            z.strictObject({ type: z.literal('post'), title: z.string().trim().min(1).max(80), body: messageBody }),
            z.strictObject({ type: z.literal('reply'), postId: z.uuid(), body: messageBody }),
          ]),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const actor = await boardActor(tx, ctx, input, true);
        const { content, worldId, confidential } = input;
        const author = { authorName: actor.name, portraitId: actor.portraitId };
        if (content.type === 'post')
          return tx.nationBoardPost.create({
            data: {
              ...author,
              worldId,
              nationId: actor.nationId,
              confidential,
              title: content.title,
              body: content.body,
            },
            select: { id: true },
          });
        const post = await tx.nationBoardPost.findFirst({
          where: { id: content.postId, worldId, nationId: actor.nationId, confidential },
          select: { id: true },
        });
        if (!post) throw new TRPCError({ code: 'NOT_FOUND', message: '게시물을 찾을 수 없습니다.' });
        return tx.nationBoardReply.create({
          data: { ...author, postId: post.id, body: content.body },
          select: { id: true },
        });
      }),
    ),
});
