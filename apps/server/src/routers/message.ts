import { TRPCError } from '@trpc/server';
import { nowTick, toGameDate, LINEAGE_EXITED_YEAR } from '@opensamguk/rules';
import { z } from 'zod';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { entityKey, worldInput, worldClock } from '../queries';
import {
  databaseTime,
  decodeMessageCursor,
  encodeMessageCursor,
  isLeader,
  messageBody,
  messageItem,
  messageScope,
  messagingActor,
  nationTagSelect,
  unreadMessages,
  visibleMessages,
  writeMessaging,
} from '../messaging';

export const messageRouter = router({
  list: protectedProcedure
    .input(worldInput.extend({ scope: messageScope, cursor: z.string().max(256).optional() }).strict())
    .query(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) => {
          const general = await messagingActor(tx, ctx, input.worldId);
          const cursor = input.cursor === undefined ? null : decodeMessageCursor(input.cursor);
          const rows = await tx.message.findMany({
            where: {
              AND: [
                { worldId: input.worldId },
                visibleMessages(general, input.scope),
                ...(cursor
                  ? [{ OR: [{ sentAt: { lt: cursor.sentAt } }, { sentAt: cursor.sentAt, id: { lt: cursor.id } }] }]
                  : []),
              ],
            },
            include: { reads: { where: { generalId: general.id } } },
            orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
            take: 21,
          });
          const page = rows.slice(0, 20);
          const ids = new Set(page.flatMap((row) => [row.senderId, row.recipientId]).filter((id) => id !== null));
          const portraits = new Map(
            (ids.size
              ? await tx.general.findMany({
                  where: { worldId: input.worldId, id: { in: [...ids] } },
                  select: { id: true, portraitId: true },
                })
              : []
            ).map(({ id, portraitId }) => [id, portraitId]),
          );
          return {
            items: page.map((row) => messageItem(row, general.id, portraits)),
            next: rows.length > 20 ? encodeMessageCursor(page.at(-1)!) : null,
          };
        },
        { isolationLevel: 'RepeatableRead' },
      ),
    ),
  send: worldVerifiedProcedure
    .input(
      worldInput
        .extend({
          scope: messageScope,
          toGeneralId: entityKey.optional(),
          toNationId: entityKey.optional(),
          body: messageBody,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      writeMessaging(ctx, async (tx, notify) => {
        const g = await messagingActor(tx, ctx, input.worldId, true);
        if (
          (input.scope === 'PRIVATE' && (input.toGeneralId === undefined || input.toNationId !== undefined)) ||
          (input.scope === 'DIPLOMACY' && (input.toNationId === undefined || input.toGeneralId !== undefined)) ||
          ((input.scope === 'NATION' || input.scope === 'WORLD') &&
            (input.toNationId !== undefined || input.toGeneralId !== undefined))
        )
          throw new TRPCError({ code: 'BAD_REQUEST', message: '받는 사람과 메시지 범위를 확인하세요.' });
        visibleMessages(g, input.scope);
        const ownNation =
          g.nationId === null
            ? null
            : await tx.nation.findUnique({
                where: { worldId_id: { worldId: input.worldId, id: g.nationId } },
                select: nationTagSelect,
              });
        const recipient =
          input.scope === 'PRIVATE'
            ? await tx.general.findUnique({
                where: { worldId_id: { worldId: input.worldId, id: input.toGeneralId! } },
                include: { nation: { select: nationTagSelect } },
              })
            : null;
        const nation =
          input.scope === 'DIPLOMACY'
            ? await tx.nation.findUnique({
                where: { worldId_id: { worldId: input.worldId, id: input.toNationId! } },
                select: nationTagSelect,
              })
            : ownNation;
        if (
          (input.scope === 'PRIVATE' &&
            (!recipient || recipient.removedAt != null || recipient.activeFromYear === LINEAGE_EXITED_YEAR)) ||
          ((input.scope === 'NATION' || input.scope === 'DIPLOMACY') && !nation) ||
          (input.scope === 'DIPLOMACY' && (!isLeader(g) || nation!.id === g.nationId))
        )
          throw new TRPCError({ code: 'BAD_REQUEST', message: '받는 사람을 찾을 수 없습니다.' });
        const now = await databaseTime(tx);
        const recent = await tx.message.findMany({
          where: { worldId: input.worldId, senderId: g.id, sentAt: { gt: new Date(now.getTime() - 60000) } },
          orderBy: { sentAt: 'asc' },
          select: { sentAt: true },
        });
        if (recent.length >= 10) {
          const seconds = Math.max(1, Math.ceil((recent[0]!.sentAt.getTime() + 60000 - now.getTime()) / 1000));
          ctx.reply.header('Retry-After', String(seconds));
          throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `${seconds}초 뒤에 다시 보낼 수 있습니다.` });
        }
        const world = await tx.world.findUniqueOrThrow({ where: { id: input.worldId } });
        const date = toGameDate(world.startYear, nowTick(worldClock(world), now.getTime()));
        const row = await tx.message.create({
          data: {
            worldId: input.worldId,
            scope: input.scope,
            senderId: g.id,
            senderNationId: g.nationId,
            recipientId: recipient?.id ?? null,
            recipientNationId: input.scope === 'NATION' || input.scope === 'DIPLOMACY' ? nation!.id : null,
            fromParty: { generalId: g.id, name: g.name, nation: ownNation, portraitId: g.portraitId },
            toParty: recipient
              ? {
                  generalId: recipient.id,
                  name: recipient.name,
                  nation: recipient.nation,
                  portraitId: recipient.portraitId,
                }
              : input.scope === 'WORLD'
                ? { generalId: null, name: '전체', nation: null }
                : { generalId: null, name: nation!.name, nation },
            body: input.body,
            sentAt: now,
            year: date.year,
            month: date.month,
          },
          include: { reads: true },
        });
        notify(input.worldId, {
          kind: 'message.new',
          scope: input.scope,
          target:
            input.scope === 'PRIVATE'
              ? { generalId: recipient!.id }
              : input.scope === 'NATION'
                ? { nationId: nation!.id }
                : input.scope === 'WORLD'
                  ? 'world'
                  : { nationIds: [g.nationId!, nation!.id], leadersOnly: true },
        });
        return { item: messageItem(row, g.id) };
      }),
    ),
  unread: protectedProcedure
    .input(worldInput)
    .query(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) => unreadMessages(tx, input.worldId, await messagingActor(tx, ctx, input.worldId)),
        { isolationLevel: 'RepeatableRead' },
      ),
    ),
  markRead: worldVerifiedProcedure
    .input(worldInput.extend({ ids: z.array(z.uuid()).min(1).max(100) }).strict())
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const g = await messagingActor(tx, ctx, input.worldId, true);
        const scopes = messageScope.options.filter(
          (scope) =>
            scope === 'PRIVATE' || scope === 'WORLD' || (scope === 'NATION' ? g.nationId !== null : isLeader(g)),
        );
        const rows = await tx.message.findMany({
          where: {
            worldId: input.worldId,
            id: { in: input.ids },
            OR: scopes.map((scope) => visibleMessages(g, scope)),
          },
          select: { id: true, senderId: true },
        });
        const changed = await tx.messageRead.createMany({
          data: rows
            .filter((row) => row.senderId !== g.id)
            .map((row) => ({ worldId: input.worldId, generalId: g.id, messageId: row.id })),
          skipDuplicates: true,
        });
        return { updated: changed.count, unread: await unreadMessages(tx, input.worldId, g) };
      }),
    ),
  recipients: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        const g = await messagingActor(tx, ctx, input.worldId);
        const generals = await tx.general.findMany({
          where: {
            worldId: input.worldId,
            id: { not: g.id },
            removedAt: null,
            activeFromYear: { not: LINEAGE_EXITED_YEAR },
          },
          select: { id: true, name: true, portraitId: true, officerLevel: true, nation: { select: nationTagSelect } },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        const nations = await tx.nation.findMany({
          where: { worldId: input.worldId, ...(g.nationId === null ? {} : { id: { not: g.nationId } }) },
          select: nationTagSelect,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        return { generals, nations };
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  ),
});
