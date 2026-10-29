import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  ADMIN_END_KIND,
  adminEndPayloadSchema,
  adminEndAppliedSchema,
  adminEndRejectedSchema,
  checkAdminEndOrigin,
  checkReplayOrigin,
  validateAdminEndRecord,
} from '@opensamguk/rules';
import type { Prisma } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import type { Context } from '../context';
import { requireCurrentAdmin } from './access';

export const worldEndRequestInput = z.strictObject({
  expectedUserId: z.uuid(),
  worldId: z.uuid(),
  idempotencyKey: z.uuid(),
});
export const requestWorldEndInput = worldEndRequestInput.extend({
  confirmName: adminEndPayloadSchema.shape.confirmName,
  expectedRevision: adminEndPayloadSchema.shape.expectedRevision,
  reason: adminEndPayloadSchema.shape.reason,
});
function expectedActor(ctx: Context, id: string) {
  if (!ctx.user || ctx.user.id !== id)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
}
function response(event: Prisma.InputEventGetPayload<Record<string, never>>) {
  if (event.kind !== ADMIN_END_KIND)
    throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
  if (event.status === 'PENDING') {
    adminEndPayloadSchema.parse(event.payload);
    if (event.generalId !== null || event.sequence !== null || event.tick !== null || event.result !== null)
      throw new Error('미완료 종료 기록이 다릅니다.');
  } else
    validateAdminEndRecord({
      sequence: event.sequence!,
      tick: event.tick,
      generalId: event.generalId,
      kind: event.kind,
      status: event.status,
      payload: event.payload,
      result: event.result,
    });
  return {
    userId: event.userId,
    worldId: event.worldId,
    idempotencyKey: event.idempotencyKey,
    requestId: String(event.id),
    action: 'end' as const,
    status: event.status,
    sequence: event.sequence,
    tick: event.tick,
    result:
      event.status === 'APPLIED'
        ? adminEndAppliedSchema.parse(event.result)
        : event.status === 'REJECTED'
          ? adminEndRejectedSchema.parse(event.result)
          : null,
  };
}
function publicError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '월드 종료 요청을 처리하지 못했습니다.' });
}
export async function requestWorldEnd(ctx: Context, input: z.infer<typeof requestWorldEndInput>) {
  expectedActor(ctx, input.expectedUserId);
  try {
    return await ctx.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id=${input.worldId} FOR UPDATE`;
      const userId = await requireCurrentAdmin(tx, ctx, true),
        key = { worldId: input.worldId, userId, idempotencyKey: input.idempotencyKey },
        payload = adminEndPayloadSchema.parse({
          version: 1,
          confirmName: input.confirmName,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
        }),
        prior = await tx.inputEvent.findUnique({ where: { worldId_userId_idempotencyKey: key } });
      if (prior) {
        const old = adminEndPayloadSchema.safeParse(prior.payload);
        if (
          prior.kind !== ADMIN_END_KIND ||
          !old.success ||
          old.data.confirmName !== payload.confirmName ||
          old.data.expectedRevision !== payload.expectedRevision ||
          old.data.reason !== payload.reason
        )
          throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
        return response(prior);
      }
      const world = await tx.world.findUnique({ where: { id: input.worldId }, include: { result: true } });
      if (!world) throw new TRPCError({ code: 'NOT_FOUND', message: '월드를 찾을 수 없습니다.' });
      try {
        checkAdminEndOrigin(world, checkReplayOrigin, hashState);
      } catch {
        throw new TRPCError({ code: 'BAD_REQUEST', message: '이 월드의 재생 형식에서는 사용할 수 없습니다.' });
      }
      if (
        world.status !== 'PAUSED' ||
        world.clockRevision !== input.expectedRevision ||
        world.name !== input.confirmName ||
        world.result ||
        world.endedAt
      )
        throw new TRPCError({ code: 'CONFLICT', message: '확인한 월드 상태가 달라졌습니다. 다시 조회하세요.' });
      const event = await tx.inputEvent.create({ data: { ...key, kind: ADMIN_END_KIND, payload } });
      await tx.auditLog.create({
        data: {
          actorKind: 'ADMIN',
          actorUserId: userId,
          action: 'world.end.requested',
          targetType: 'World',
          targetId: world.id,
          worldId: world.id,
          reason: payload.reason,
          inputEventId: event.id,
          payload: { requestId: String(event.id), idempotencyKey: input.idempotencyKey },
        },
      });
      return response(event);
    });
  } catch (error) {
    publicError(error);
  }
}
export async function getWorldEndRequest(ctx: Context, input: z.infer<typeof worldEndRequestInput>) {
  expectedActor(ctx, input.expectedUserId);
  try {
    return await ctx.db.$transaction(async (tx) => {
      await requireCurrentAdmin(tx, ctx, false);
      const event = await tx.inputEvent.findUnique({
        where: {
          worldId_userId_idempotencyKey: {
            worldId: input.worldId,
            userId: ctx.user!.id,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (!event || event.kind !== ADMIN_END_KIND)
        throw new TRPCError({ code: 'NOT_FOUND', message: '월드 종료 요청을 찾을 수 없습니다.' });
      return response(event);
    });
  } catch (error) {
    publicError(error);
  }
}
