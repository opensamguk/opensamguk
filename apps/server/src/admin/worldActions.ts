import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  adminClockActionSchema,
  adminClockPayloadSchema,
  adminClockExpectedStatus,
  isAdminClockKind,
  adminClockAppliedSchema,
  adminClockRejectedSchema,
} from '@opensamguk/rules';
import type { Context } from '../context';
import { requireCurrentAdmin } from './access';

export const requestWorldClockInput = z.strictObject({
  expectedUserId: z.uuid(),
  worldId: z.uuid(),
  idempotencyKey: z.uuid(),
  action: adminClockActionSchema,
  reason: adminClockPayloadSchema.shape.reason,
});
export const worldClockRequestInput = z.strictObject({
  expectedUserId: z.uuid(),
  worldId: z.uuid(),
  idempotencyKey: z.uuid(),
});
function expectedActor(ctx: Context, expectedUserId: string) {
  if (!ctx.user || ctx.user.id !== expectedUserId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
}
function publicError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '월드 요청을 처리하지 못했습니다.' });
}
function response(event: {
  id: bigint;
  kind: string;
  status: string;
  sequence: number | null;
  tick: number | null;
  result: unknown;
}) {
  if (!isAdminClockKind(event.kind))
    throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
  const result =
    event.status === 'APPLIED'
      ? adminClockAppliedSchema.parse(event.result)
      : event.status === 'REJECTED'
        ? adminClockRejectedSchema.parse(event.result)
        : null;
  return {
    requestId: String(event.id),
    action: event.kind.slice('admin.world.'.length) as z.infer<typeof adminClockActionSchema>,
    status: event.status,
    sequence: event.sequence,
    tick: event.tick,
    result,
  };
}
export async function requestWorldClock(ctx: Context, input: z.infer<typeof requestWorldClockInput>) {
  expectedActor(ctx, input.expectedUserId);
  try {
    return await ctx.db.$transaction(async (tx) => {
      // 엔진의 World→User 잠금 순서를 유지하며 같은 월드의 중복 접수를 직렬화한다.
      await tx.$queryRaw`SELECT id FROM "World" WHERE id=${input.worldId} FOR UPDATE`;
      const actorUserId = await requireCurrentAdmin(tx, ctx, true);
      const key = { worldId: input.worldId, userId: actorUserId, idempotencyKey: input.idempotencyKey };
      const prior = await tx.inputEvent.findUnique({ where: { worldId_userId_idempotencyKey: key } });
      const kind = 'admin.world.' + input.action,
        payload = { version: 1 as const, reason: input.reason };
      if (prior) {
        const parsed = adminClockPayloadSchema.safeParse(prior.payload);
        if (prior.kind !== kind || !parsed.success || parsed.data.reason !== input.reason)
          throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
        return response(prior);
      }
      const world = await tx.world.findUnique({
        where: { id: input.worldId },
        select: { status: true, replayFormat: true },
      });
      if (!world) throw new TRPCError({ code: 'NOT_FOUND', message: '월드를 찾을 수 없습니다.' });
      if (world.replayFormat !== 3)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '이 월드의 재생 형식에서는 사용할 수 없습니다.' });
      if (world.status !== adminClockExpectedStatus[input.action])
        throw new TRPCError({ code: 'CONFLICT', message: '월드 상태가 바뀌었습니다. 다시 조회하세요.' });
      const event = await tx.inputEvent.create({ data: { ...key, kind, payload } });
      await tx.auditLog.create({
        data: {
          actorKind: 'ADMIN',
          actorUserId,
          action: kind.slice('admin.'.length) + '.requested',
          targetType: 'World',
          targetId: input.worldId,
          worldId: input.worldId,
          reason: input.reason,
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
export async function getWorldClockRequest(ctx: Context, input: z.infer<typeof worldClockRequestInput>) {
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
      if (!event || !isAdminClockKind(event.kind))
        throw new TRPCError({ code: 'NOT_FOUND', message: '월드 요청을 찾을 수 없습니다.' });
      return response(event);
    });
  } catch (error) {
    publicError(error);
  }
}
