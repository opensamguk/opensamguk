import { randomBytes, randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import {
  ADMIN_RESET_KIND,
  adminResetIntent,
  adminResetPayloadSchema,
  adminResetAppliedSchema,
  adminResetRejectedSchema,
  requestWorldResetInput,
  worldResetRequestInput,
  validateAdminResetRecord,
  checkAdminEndOrigin,
  checkReplayOrigin,
} from '@opensamguk/rules';
import type { z } from 'zod';
import type { Context } from '../context';
import { requireCurrentAdmin } from './access';

function expectedActor(ctx: Context, expectedUserId: string) {
  if (!ctx.user || ctx.user.id !== expectedUserId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
}
type Event = Prisma.InputEventGetPayload<Record<string, never>>;
function response(event: Event) {
  const payload = adminResetPayloadSchema.parse(event.payload);
  if (event.kind !== ADMIN_RESET_KIND || payload.sourceWorldId !== event.worldId)
    throw new Error('초기화 요청의 원본 월드가 다릅니다.');
  if (event.status === 'PENDING') {
    if (event.generalId !== null || event.sequence !== null || event.tick !== null || event.result !== null)
      throw new Error('미완료 초기화 기록이 다릅니다.');
  } else
    validateAdminResetRecord(
      {
        sequence: event.sequence!,
        tick: event.tick,
        generalId: event.generalId,
        kind: event.kind,
        status: event.status,
        payload: event.payload,
        result: event.result,
      },
      event.worldId,
    );
  return {
    userId: event.userId,
    worldId: event.worldId,
    idempotencyKey: event.idempotencyKey,
    requestId: String(event.id),
    action: 'reset' as const,
    status: event.status,
    sequence: event.sequence,
    tick: event.tick,
    plannedNewWorldId: payload.plannedNewWorldId,
    result:
      event.status === 'APPLIED'
        ? adminResetAppliedSchema.parse(event.result)
        : event.status === 'REJECTED'
          ? adminResetRejectedSchema.parse(event.result)
          : null,
  };
}
function publicError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '월드 초기화 요청을 처리하지 못했습니다.' });
}
export async function requestWorldReset(ctx: Context, input: z.infer<typeof requestWorldResetInput>) {
  expectedActor(ctx, input.expectedUserId);
  const intent = adminResetIntent(input);
  try {
    return await ctx.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "World" WHERE id=${input.worldId} FOR UPDATE`;
        const userId = await requireCurrentAdmin(tx, ctx, true),
          key = { worldId: input.worldId, userId, idempotencyKey: input.idempotencyKey };
        const prior = await tx.inputEvent.findUnique({ where: { worldId_userId_idempotencyKey: key } });
        if (prior) {
          const payload = adminResetPayloadSchema.safeParse(prior.payload);
          if (
            prior.kind !== ADMIN_RESET_KIND ||
            !payload.success ||
            payload.data.sourceWorldId !== input.worldId ||
            hashState(payload.data.intent) !== hashState(intent)
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
          world.name !== intent.confirmName ||
          world.clockRevision !== intent.expectedRevision ||
          world.result ||
          world.endedAt
        )
          throw new TRPCError({ code: 'CONFLICT', message: '확인한 월드 상태가 달라졌습니다. 다시 조회하세요.' });
        const payload = adminResetPayloadSchema.parse({
          version: 1,
          sourceWorldId: input.worldId,
          intent,
          plannedNewWorldId: randomUUID(),
          effectiveSeed: intent.requestedSeed ?? randomBytes(16).toString('hex'),
        });
        const event = await tx.inputEvent.create({ data: { ...key, kind: ADMIN_RESET_KIND, payload } });
        await tx.auditLog.create({
          data: {
            actorKind: 'ADMIN',
            actorUserId: userId,
            action: 'world.reset.requested',
            targetType: 'World',
            targetId: world.id,
            worldId: world.id,
            reason: intent.reason,
            inputEventId: event.id,
            payload: {
              requestId: String(event.id),
              idempotencyKey: input.idempotencyKey,
              plannedNewWorldId: payload.plannedNewWorldId,
            },
          },
        });
        return response(event);
      },
      { timeout: 30000 },
    );
  } catch (error) {
    publicError(error);
  }
}
export async function getWorldResetRequest(ctx: Context, input: z.infer<typeof worldResetRequestInput>) {
  expectedActor(ctx, input.expectedUserId);
  try {
    return await ctx.db.$transaction(async (tx) => {
      const userId = await requireCurrentAdmin(tx, ctx, false);
      const event = await tx.inputEvent.findUnique({
        where: {
          worldId_userId_idempotencyKey: { worldId: input.worldId, userId, idempotencyKey: input.idempotencyKey },
        },
      });
      if (!event || event.kind !== ADMIN_RESET_KIND)
        throw new TRPCError({ code: 'NOT_FOUND', message: '월드 초기화 요청을 찾을 수 없습니다.' });
      return response(event);
    });
  } catch (error) {
    publicError(error);
  }
}
