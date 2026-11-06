import { assertStorableJson, type Prisma } from '@opensamguk/db';
import { noticeDirectiveSchema } from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { worldInput, entityKey } from '../queries';
import { bodyLimit, databaseTime, isLeader, messagingActor, writeMessaging } from '../messaging';
import type { Context } from '../context';
import { requireWorld } from '../game/queries';
import { worldResolver } from '../game/resolver';

async function nationNotice(tx: Prisma.TransactionClient, ctx: Context, worldId: string) {
  const g = await messagingActor(tx, ctx, worldId);
  if (g.nationId === null) return null;
  const nation = await tx.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: g.nationId } } });
  const seen = z.object({ nationId: entityKey, revision: z.number().int().nonnegative() }).safeParse(g.noticeSeen);
  const directive = nation.noticeDirective === null ? null : noticeDirectiveSchema.parse(nation.noticeDirective);
  return {
    nationId: nation.id,
    revision: nation.noticeRevision,
    body: nation.notice,
    ...(directive === null ? {} : { directive }),
    updatedAt: nation.noticeUpdatedAt?.toISOString() ?? null,
    updatedBy: nation.noticeUpdatedBy,
    unseen:
      (nation.notice !== '' || directive !== null) &&
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
    set: worldVerifiedProcedure
      .input(worldInput.extend({ body: bodyLimit, directive: noticeDirectiveSchema.nullable().optional() }).strict())
      .mutation(({ ctx, input }) =>
        writeMessaging(ctx, async (tx, notify) => {
          const g = await messagingActor(tx, ctx, input.worldId, true);
          if (!isLeader(g))
            throw new TRPCError({ code: 'FORBIDDEN', message: '군주와 참모만 국가 공지를 바꿀 수 있습니다.' });
          let directive = input.directive;
          if (directive != null) {
            const { resolver } = worldResolver(await requireWorld(tx, input.worldId));
            const definition = resolver.get(directive.commandKey);
            const parsed = definition?.target === 'general' ? definition.args.safeParse(directive.args) : undefined;
            if (!definition || !parsed?.success)
              throw new TRPCError({ code: 'BAD_REQUEST', message: '이 월드에서 쓸 장수 명령과 선택값을 확인하세요.' });
            try {
              assertStorableJson(parsed.data, 'directive.args');
              directive = noticeDirectiveSchema.parse({ commandKey: definition.key, args: parsed.data });
            } catch {
              throw new TRPCError({ code: 'BAD_REQUEST', message: '공지 지시의 선택값을 확인하세요.' });
            }
          }
          await tx.nation.update({
            where: { worldId_id: { worldId: input.worldId, id: g.nationId! } },
            data: {
              notice: input.body,
              noticeRevision: { increment: 1 },
              noticeUpdatedAt: await databaseTime(tx),
              noticeUpdatedBy: g.name,
            },
          });
          if (directive !== undefined) {
            // 공지와 지시는 규칙 밖 metadata이며 본문·revision과 같은 트랜잭션으로 저장한다.
            const json = directive === null ? null : JSON.stringify(directive);
            await tx.$executeRaw`UPDATE "Nation" SET "noticeDirective" = ${json}::jsonb
            WHERE "worldId" = ${input.worldId} AND id = ${g.nationId}`;
          }
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
