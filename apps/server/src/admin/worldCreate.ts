import { randomUUID, randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import {
  requestWorldCreateInput,
  worldCreateStatusInput,
  worldCreateIntent,
  worldCreateRejectMessages,
} from '@opensamguk/rules';
import type { z } from 'zod';
import type { Context } from '../context';
import { requireCurrentAdmin } from './access';

function expectedActor(ctx: Context, expectedUserId: string) {
  if (!ctx.user || ctx.user.id !== expectedUserId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
}
type Request = Prisma.WorldCreateRequestGetPayload<Record<string, never>>;
function response(request: Request) {
  let error: { code: string; message: string } | null = null;
  if (request.status === 'FAILED') {
    const code = request.errorCode;
    if (code === null || !Object.hasOwn(worldCreateRejectMessages, code)) throw new Error('생성 요청 결과가 다릅니다.');
    error = { code, message: worldCreateRejectMessages[code as keyof typeof worldCreateRejectMessages] };
  }
  return {
    userId: request.requestedBy,
    requestId: request.id,
    idempotencyKey: request.idempotencyKey,
    status: request.status,
    worldId: request.status === 'DONE' ? request.worldId : null,
    error,
  };
}
function publicError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '월드 생성 요청을 처리하지 못했습니다.' });
}
export async function requestWorldCreate(ctx: Context, input: z.infer<typeof requestWorldCreateInput>) {
  expectedActor(ctx, input.expectedUserId);
  const intent = worldCreateIntent(input),
    intentHash = hashState(intent);
  try {
    return await ctx.db.$transaction(async (tx) => {
      const requestedBy = await requireCurrentAdmin(tx, ctx, true);
      // User 잠금 뒤 요청 행은 MVCC로만 읽어 엔진의 request→User 순서와 교착하지 않는다.
      const prior = await tx.worldCreateRequest.findUnique({
        where: { requestedBy_idempotencyKey: { requestedBy, idempotencyKey: input.idempotencyKey } },
      });
      if (prior) {
        if (prior.intentHash !== intentHash)
          throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
        return response(prior);
      }
      const request = await tx.worldCreateRequest.create({
        data: {
          requestedBy,
          idempotencyKey: input.idempotencyKey,
          intentHash,
          intent,
          effectiveSeed: intent.seed ?? randomBytes(16).toString('hex'),
          plannedWorldId: randomUUID(),
        },
      });
      await tx.auditLog.create({
        data: {
          actorKind: 'ADMIN',
          actorUserId: requestedBy,
          action: 'world.create.requested',
          targetType: 'WorldCreateRequest',
          targetId: request.id,
          payload: { requestId: request.id, idempotencyKey: input.idempotencyKey, intentHash },
        },
      });
      return response(request);
    });
  } catch (error) {
    publicError(error);
  }
}
export async function getWorldCreateRequest(ctx: Context, input: z.infer<typeof worldCreateStatusInput>) {
  expectedActor(ctx, input.expectedUserId);
  try {
    return await ctx.db.$transaction(async (tx) => {
      const requestedBy = await requireCurrentAdmin(tx, ctx, false);
      const request = await tx.worldCreateRequest.findFirst({
        where: {
          requestedBy,
          ...(input.requestId === undefined ? { idempotencyKey: input.idempotencyKey! } : { id: input.requestId }),
        },
      });
      if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: '월드 생성 요청을 찾을 수 없습니다.' });
      return response(request);
    });
  } catch (error) {
    publicError(error);
  }
}
