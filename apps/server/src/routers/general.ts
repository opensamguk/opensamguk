import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TRPCError } from '@trpc/server';
import {
  CREATION_ERRORS,
  creationBlock,
  generalCreationSchema,
  validateGeneralCreation,
  type CreationCode,
  type InitialGeneral,
} from '@opensamguk/rules';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { requireWorld, worldInput } from '../game/queries';
import { ownGeneral } from '../game/projection';

const codes = {
  ALREADY_EXISTS: 'CONFLICT',
  NAME_TAKEN: 'CONFLICT',
  BAD_NAME: 'BAD_REQUEST',
  BAD_STATS: 'BAD_REQUEST',
  BAD_PORTRAIT: 'BAD_REQUEST',
  WORLD_CLOSED: 'PRECONDITION_FAILED',
  ACTOR_INACTIVE: 'UNAUTHORIZED',
} as const;
function rejection(result: unknown) {
  const code = (result as { code?: string } | null)?.code;
  if (!code || !Object.hasOwn(CREATION_ERRORS, code))
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '생성 결과를 확인하지 못했습니다.' });
  const known = code as CreationCode;
  return { code: known, message: CREATION_ERRORS[known] };
}
const createInput = generalCreationSchema.extend(worldInput.shape);
const creationEnvelope = worldInput.extend({
  name: z.unknown(),
  leadership: z.unknown(),
  strength: z.unknown(),
  intel: z.unknown(),
  portraitId: z.unknown(),
});
const creationInputParser = {
  parse(value: unknown): z.input<typeof createInput> {
    // 허용한 키와 월드 ID부터 검사하고 생성 필드는 장수·월드 판정 뒤에 검사한다.
    creationEnvelope.parse(value);
    return value as z.input<typeof createInput>;
  },
};
export const generalRouter = router({
  create: protectedProcedure.input(creationInputParser).mutation(async ({ ctx, input }) => {
    const started = performance.now();
    const { worldId, ...payload } = input;
    const id = await ctx.db.$transaction(async (tx) => {
      const world = await requireWorld(tx, worldId, true);
      const existing = await tx.general.findUnique({ where: { worldId_userId: { worldId, userId: ctx.user.id } } });
      const pending = await tx.inputEvent.findFirst({
        where: { worldId, userId: ctx.user.id, kind: 'general.create', status: 'PENDING' },
        orderBy: { id: 'asc' },
      });
      const block = creationBlock({
        status: world.status,
        hasGeneral: existing !== null,
        hasPending: pending !== null,
      });
      if (block && block.code !== 'PENDING')
        throw new TRPCError({ code: codes[block.code], message: CREATION_ERRORS[block.code] });
      const parsed = createInput.safeParse(input);
      if (!parsed.success)
        throw new TRPCError({ code: 'BAD_REQUEST', message: parsed.error.message, cause: parsed.error });
      const checked = validateGeneralCreation(payload, world.statRules);
      if (!checked.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: checked.message });
      if (pending) {
        // PostgreSQL jsonb의 키 순서는 입력 객체 순서와 다르다.
        const equal =
          Object.entries(checked.value).every(
            ([key, value]) => (pending.payload as Record<string, unknown>)[key] === value,
          ) && Object.keys(pending.payload as object).length === Object.keys(checked.value).length;
        if (!equal) throw new TRPCError({ code: 'CONFLICT', message: '생성 요청이 진행 중입니다.' });
        return pending.id;
      }
      const event = await tx.inputEvent.create({
        data: {
          worldId,
          userId: ctx.user.id,
          kind: 'general.create',
          idempotencyKey: `general.create:${randomUUID()}`,
          payload: checked.value,
          status: 'PENDING',
          sequence: null,
        },
      });
      return event.id;
    });
    const deadline = performance.now() + 5000;
    while (true) {
      const event = await ctx.db.inputEvent.findUniqueOrThrow({ where: { id } });
      if (event.status === 'APPLIED') {
        // 대기 중 계정이 제재되거나 세션이 지워지면 결과를 노출하지 않는다.
        const session = await ctx.db.session.findFirst({
          where: {
            id: ctx.sessionId!,
            userId: ctx.user.id,
            expiresAt: { gt: new Date(ctx.now + performance.now() - started) },
            user: { status: 'ACTIVE' },
          },
        });
        if (!session) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
        return {
          status: 'created' as const,
          general: ownGeneral((event.result as unknown as { general: InitialGeneral }).general),
        };
      }
      if (event.status === 'REJECTED') {
        const error = rejection(event.result);
        throw new TRPCError({ code: codes[error.code], message: error.message });
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { status: 'pending' as const };
      await delay(Math.min(100, remaining));
    }
  }),
  mine: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        await requireWorld(tx, input.worldId);
        const general = await tx.general.findUnique({
          where: { worldId_userId: { worldId: input.worldId, userId: ctx.user.id } },
        });
        if (general) return { general: ownGeneral(general), creation: null };
        const event = await tx.inputEvent.findFirst({
          where: { worldId: input.worldId, userId: ctx.user.id, kind: 'general.create' },
          orderBy: { id: 'desc' },
        });
        const creation =
          event?.status === 'PENDING'
            ? { status: 'pending' as const }
            : event?.status === 'REJECTED'
              ? { status: 'rejected' as const, ...rejection(event.result) }
              : null;
        return { general: null, creation };
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  ),
});
