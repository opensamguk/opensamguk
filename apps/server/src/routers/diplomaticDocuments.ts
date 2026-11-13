import type { Prisma } from '@opensamguk/db';
import { canExecuteNationCommand } from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { requireGeneral, requireWorld, worldInput } from '../game/queries';
import { requireLiveSession } from '../game/treatyRequests';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';

const documentId = z.number().int().positive().max(2_147_483_647);
const sendInput = worldInput.extend({
  requestId: z.uuid(),
  toNationId: documentId,
  previousId: documentId.optional(),
  brief: z.string().trim().min(1).max(2000),
  detail: z.string().trim().max(20_000),
});

async function documentAccess(
  tx: Prisma.TransactionClient,
  worldId: string,
  ctx: { user: { id: string }; sessionId?: string | null; now: number },
  write = false,
) {
  await requireLiveSession(tx, { userId: ctx.user.id, sessionId: ctx.sessionId ?? '', at: new Date(ctx.now) });
  const world = await requireWorld(tx, worldId, write);
  if (write && world.status === 'ENDED')
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '종료된 월드입니다.' });
  const actor = await requireGeneral(tx, worldId, ctx.user.id, write);
  const canWrite = canExecuteNationCommand(actor.officerLevel, 'nation_pact');
  if (actor.nationId === null || actor.removedAt !== null || (write && !canWrite))
    throw new TRPCError({ code: 'FORBIDDEN', message: '외교 문서를 처리할 권한이 없습니다.' });
  return { actor, nationId: actor.nationId, canWrite, canReadDetail: canWrite };
}

function unavailable(): never {
  throw new TRPCError({ code: 'NOT_FOUND', message: '외교 문서를 찾을 수 없습니다.' });
}

export const diplomaticDocumentsRouter = router({
  list: protectedProcedure
    .input(worldInput.extend({ beforeId: documentId.optional() }))
    .query(({ ctx, input: { worldId, beforeId } }) =>
      ctx.db.$transaction(
        async (tx) => {
          const { nationId, canWrite, canReadDetail } = await documentAccess(tx, worldId, ctx);
          const documents = await tx.diplomaticDocument.findMany({
            where: {
              worldId,
              OR: [{ fromNationId: nationId }, { toNationId: nationId }],
              ...(beforeId === undefined ? {} : { id: { lt: beforeId } }),
            },
            orderBy: { id: 'desc' },
            take: 31,
            select: {
              id: true,
              fromNationId: true,
              toNationId: true,
              fromNationName: true,
              toNationName: true,
              senderName: true,
              responderName: true,
              previousId: true,
              status: true,
              brief: true,
              detail: canReadDetail,
              responseReason: canReadDetail,
              createdAt: true,
            },
          });
          const items = documents.slice(0, 30).map((row) => ({
            ...row,
            detail: row.detail ?? null,
            responseReason: row.responseReason ?? null,
          }));
          const targets = canWrite
            ? await tx.nation.findMany({
                where: { worldId, id: { not: nationId } },
                orderBy: { name: 'asc' },
                select: { id: true, name: true },
              })
            : [];
          return { items, nextBeforeId: documents.length > 30 ? items.at(-1)!.id : null, nationId, canWrite, targets };
        },
        { isolationLevel: 'RepeatableRead' },
      ),
    ),
  send: worldVerifiedProcedure.input(sendInput).mutation(({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const { worldId, requestId, toNationId, previousId = null, brief, detail } = input;
      const { actor, nationId } = await documentAccess(tx, worldId, ctx, true);
      const existing = await tx.diplomaticDocument.findUnique({ where: { worldId_requestId: { worldId, requestId } } });
      if (existing) {
        if (
          existing.senderId !== actor.id ||
          existing.fromNationId !== nationId ||
          existing.toNationId !== toNationId ||
          existing.previousId !== previousId ||
          existing.brief !== brief ||
          existing.detail !== detail
        )
          throw new TRPCError({ code: 'CONFLICT', message: '외교 문서 요청 식별자가 겹칩니다.' });
        return { id: existing.id };
      }
      if (nationId === toNationId) throw new TRPCError({ code: 'BAD_REQUEST', message: '자국에 보낼 수 없습니다.' });
      const nations = await tx.nation.findMany({
        where: { worldId, id: { in: [nationId, toNationId] } },
        select: { id: true, name: true },
      });
      const from = nations.find(({ id }) => id === nationId);
      const to = nations.find(({ id }) => id === toNationId);
      if (!from || !to) throw new TRPCError({ code: 'NOT_FOUND', message: '외교 상대국이 없습니다.' });
      if (previousId !== null) {
        const previous = await tx.diplomaticDocument.findUnique({
          where: { worldId_id: { worldId, id: previousId } },
          select: {
            fromNationId: true,
            toNationId: true,
            status: true,
            successors: { where: { status: { not: 'CANCELLED' } }, select: { id: true }, take: 1 },
          },
        });
        if (
          !previous ||
          ![previous.fromNationId, previous.toNationId].includes(nationId) ||
          ![previous.fromNationId, previous.toNationId].includes(toNationId)
        )
          unavailable();
        if (previous.successors.length)
          throw new TRPCError({ code: 'CONFLICT', message: '이 문서의 후속 문서가 이미 있습니다.' });
        if (previous.status === 'PROPOSED')
          await tx.diplomaticDocument.update({
            where: { worldId_id: { worldId, id: previousId } },
            data: { status: 'REPLACED' },
          });
      }
      return tx.diplomaticDocument.create({
        data: {
          worldId,
          requestId,
          fromNationId: nationId,
          toNationId,
          fromNationName: from.name,
          toNationName: to.name,
          senderId: actor.id,
          senderName: actor.name,
          previousId,
          brief,
          detail,
        },
        select: { id: true },
      });
    }),
  ),
  respond: worldVerifiedProcedure
    .input(
      worldInput.extend({
        id: documentId,
        action: z.enum(['accept', 'decline', 'withdraw']),
        reason: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(({ ctx, input: { worldId, id, action, reason } }) =>
      ctx.db.$transaction(async (tx) => {
        const { actor, nationId } = await documentAccess(tx, worldId, ctx, true);
        const where = { worldId_id: { worldId, id } };
        const row = await tx.diplomaticDocument.findUnique({ where });
        if (!row || (action === 'withdraw' ? row.fromNationId : row.toNationId) !== nationId) unavailable();
        if (row.status !== 'PROPOSED')
          throw new TRPCError({ code: 'CONFLICT', message: '이미 처리된 외교 문서입니다.' });
        if (action === 'accept' && row.previousId !== null) {
          // 진행 중인 후속 문서가 거절되면 이전에 합의한 문서는 유효하다.
          // 후속 문서가 승인된 경우에만 연쇄의 기존 합의 문서를 대체한다.
          await tx.$executeRaw`
            WITH RECURSIVE history AS (
              SELECT id, "previousId" FROM "DiplomaticDocument"
              WHERE "worldId" = ${worldId} AND id = ${row.previousId}
              UNION ALL
              SELECT d.id, d."previousId" FROM "DiplomaticDocument" d
              JOIN history h ON d.id = h."previousId" WHERE d."worldId" = ${worldId}
            )
            UPDATE "DiplomaticDocument" SET status = 'REPLACED'
            WHERE "worldId" = ${worldId} AND status = 'ACTIVE' AND id IN (SELECT id FROM history)
          `;
        }
        return tx.diplomaticDocument.update({
          where,
          data: {
            status: action === 'accept' ? 'ACTIVE' : 'CANCELLED',
            responderName: actor.name,
            responseReason: reason || null,
          },
          select: { id: true, status: true },
        });
      }),
    ),
});
