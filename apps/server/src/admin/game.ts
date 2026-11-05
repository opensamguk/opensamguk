import { hashState } from '@opensamguk/shared/node';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  adminGameActionSchema,
  adminGamePayloadSchema,
  adminGameAppliedSchema,
  adminGameRejectedSchema,
  isAdminGameKind,
} from '@opensamguk/rules';
import type { Context } from '../context';
import { requireCurrentAdmin } from './access';
import { requireAdminRole } from './role';
import { verifiedProcedure } from '../trpc';

export const adminGameRequestInput = z.strictObject({
  expectedUserId: z.uuid(),
  worldId: z.uuid(),
  idempotencyKey: z.uuid(),
  reason: adminGamePayloadSchema.shape.reason,
  action: adminGameActionSchema,
});
export const adminGameRequestStatusInput = adminGameRequestInput.pick({
  expectedUserId: true,
  worldId: true,
  idempotencyKey: true,
});
// 인증·약관 경계를 지난 운영 요청의 권한·형식·접수 거절을 원래 트랜잭션 밖에 남긴다.
export const adminGameRequestProcedure = verifiedProcedure.use(async ({ ctx, next, getRawInput }) => {
  async function rejected(error: unknown) {
    const parsed = adminGameRequestInput.safeParse(await getRawInput().catch(() => undefined));
    await ctx.db.auditLog.create({
      data: {
        actorKind: 'ADMIN',
        actorUserId: ctx.user.id,
        action: 'game.request.rejected',
        targetType: 'World',
        targetId: parsed.success ? parsed.data.worldId : null,
        worldId: parsed.success ? parsed.data.worldId : null,
        reason: parsed.success ? parsed.data.reason : null,
        payload: { code: error instanceof TRPCError ? error.code : 'INTERNAL_SERVER_ERROR' },
      },
    });
  }
  try {
    await requireAdminRole(ctx.db, ctx.user.id);
  } catch (error) {
    await rejected(error);
    throw error;
  }
  const result = await next();
  if (!result.ok) await rejected(result.error);
  return result;
});
function expectedActor(ctx: Context, expectedUserId: string) {
  if (!ctx.user || ctx.user.id !== expectedUserId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
}
function publicError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '관리자 게임 요청을 처리하지 못했습니다.' });
}
function response(event: {
  id: bigint;
  kind: string;
  status: string;
  sequence: number | null;
  tick: number | null;
  payload: unknown;
  result: unknown;
}) {
  const payload = adminGamePayloadSchema.parse(event.payload);
  if (!isAdminGameKind(event.kind) || event.kind !== payload.action.kind)
    throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
  return {
    requestId: String(event.id),
    kind: event.kind,
    status: event.status,
    sequence: event.sequence,
    tick: event.tick,
    result:
      event.status === 'APPLIED'
        ? adminGameAppliedSchema(payload.action).parse(event.result)
        : event.status === 'REJECTED'
          ? adminGameRejectedSchema.parse(event.result)
          : null,
  };
}
export async function requestAdminGame(ctx: Context, input: z.infer<typeof adminGameRequestInput>) {
  expectedActor(ctx, input.expectedUserId);
  try {
    return await ctx.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id=${input.worldId} FOR UPDATE`;
      const userId = await requireCurrentAdmin(tx, ctx, true);
      const key = { worldId: input.worldId, userId, idempotencyKey: input.idempotencyKey };
      const prior = await tx.inputEvent.findUnique({ where: { worldId_userId_idempotencyKey: key } });
      const payload = adminGamePayloadSchema.parse({ version: 1, reason: input.reason, action: input.action });
      if (prior) {
        if (prior.kind !== payload.action.kind || hashState(prior.payload) !== hashState(payload))
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
      if (!['RUNNING', 'PAUSED'].includes(world.status))
        throw new TRPCError({ code: 'CONFLICT', message: '월드 상태가 바뀌었습니다. 다시 조회하세요.' });
      const event = await tx.inputEvent.create({ data: { ...key, kind: payload.action.kind, payload } });
      const action = payload.action;
      await tx.auditLog.create({
        data: {
          actorKind: 'ADMIN',
          actorUserId: userId,
          action: 'game.request',
          targetType: 'cityKey' in action ? 'City' : 'generalId' in action ? 'General' : 'Nation',
          targetId: String(
            'cityKey' in action ? action.cityKey : 'generalId' in action ? action.generalId : action.nationId,
          ),
          worldId: input.worldId,
          reason: input.reason,
          inputEventId: event.id,
          payload: { kind: action.kind, requestId: String(event.id), idempotencyKey: input.idempotencyKey },
        },
      });
      return response(event);
    });
  } catch (error) {
    publicError(error);
  }
}
export async function getAdminGameRequest(ctx: Context, input: z.infer<typeof adminGameRequestStatusInput>) {
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
      if (!event || !isAdminGameKind(event.kind))
        throw new TRPCError({ code: 'NOT_FOUND', message: '관리자 게임 요청을 찾을 수 없습니다.' });
      return response(event);
    });
  } catch (error) {
    publicError(error);
  }
}
